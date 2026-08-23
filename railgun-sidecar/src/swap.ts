/**
 * The private swap: unshield -> swap -> reshield, as one cross-contract call.
 *
 * Three SDK calls, in a fixed order, and none of them optional:
 *
 *   1. gasEstimateForUnprovenCrossContractCalls
 *        Runs the transaction with a dummy proof to price it. Must precede
 *        proof generation, because the proof commits to the gas parameters.
 *   2. generateCrossContractCallsProof
 *        The real Groth16 proof. Takes minutes and pins the exact unshield
 *        amounts, cross-contract calls, and reshield recipients.
 *   3. populateProvedCrossContractCalls
 *        Wraps the proof into a broadcastable RelayAdapt transaction.
 *
 * The proof binds the calls, so nothing between steps 2 and 3 can be altered
 * without invalidating it. That is the property that makes it safe for a public
 * EOA to broadcast a transaction spending shielded funds it cannot see.
 */

import { ContractTransactionReceipt, TransactionRequest, Wallet } from "ethers";
import {
  gasEstimateForUnprovenCrossContractCalls,
  generateCrossContractCallsProof,
  getRelayAdaptTransactionError,
  populateProvedCrossContractCalls,
} from "@railgun-community/wallet";
import {
  NetworkName,
  RailgunERC20Amount,
  RailgunERC20Recipient,
  TXIDVersion,
} from "@railgun-community/shared-models";

import { explorerTxUrl, networkConfig, resolveAsset } from "./config";
import { getUnshieldFeeBasisPoints, poiConfigured } from "./engine";
import { createSubmitter, submitWithOptionalFallback } from "./submission";
import { UniswapV3SwapRecipe } from "./recipes";
import { quoteExactInputSingle } from "./uniswapV3";
import { get0zkAddress, getEncryptionKey, getShieldedBalance, getSubmitter, getWalletId } from "./wallet";

const TXID_VERSION = TXIDVersion.V2_PoseidonMerkle;
const NETWORK = NetworkName.EthereumSepolia;

export interface SwapParams {
  sellToken: string;
  buyToken: string;
  sellAmount: bigint;
  slippageBps?: number;
  feeTier?: number;
}

export interface SwapResult {
  txHash: string;
  blockNumber: number;
  gasUsed: string;
  sellSymbol: string;
  buySymbol: string;
  sellAmount: string;
  /** After Railgun's unshield fee; this is what actually reaches Uniswap. */
  netSellAmount: string;
  unshieldFee: string;
  quotedBuyAmount: string;
  minimumBuyAmount: string;
  feeTier: number;
  proofDurationMs: number;
  relayAdaptContract: string;
  explorerUrl: string;
  recipient0zk: string;
  /** How the transaction reached the chain, and whether it was mempool-exposed. */
  submission: {
    mode: "public" | "private";
    route: string;
    mempoolExposed: boolean;
  };
  /**
   * What the execution actually looked like once mined.
   *
   * Whether a swap was sandwiched is not something a submission route can
   * assert — it is something the receipt can show. These fields are measured
   * from the mined block, not claimed.
   */
  execution: {
    /** Tokens actually received, read from the pool's own Swap event. */
    actualBuyAmount: string;
    /**
     * Realised execution against the pre-trade quote, in basis points.
     * Negative means worse than quoted, which is the direction a sandwich
     * moves it. Small negatives are ordinary drift between quote and block.
     */
    versusQuoteBps: number;
    /** How much of the slippage budget the realised price consumed, 0-100. */
    slippageBudgetUsedPercent: number;
    /**
     * Other swaps on the same pool in the same block. A sandwich requires at
     * least one before and one after ours, so zero is positive evidence that
     * no sandwich occurred — the strongest statement available from a receipt.
     */
    otherSwapsOnPoolInBlock: number;
    /** True only when the shape of a sandwich is actually present. */
    sandwichPatternObserved: boolean;
  };
}

/** Uniswap V3 `Swap(address,address,int256,int256,uint160,uint128,int24)`. */
const UNISWAP_V3_SWAP_TOPIC =
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

/**
 * Measure what the swap actually got, from the mined block.
 *
 * This deliberately reports evidence rather than a verdict. "Protected from
 * MEV" is not observable; "received X against a quote of Y, and no other
 * transaction touched this pool in this block" is. A demo that measures the
 * second is honest whether or not the first is true.
 */
async function measureExecution(
  provider: NonNullable<Wallet["provider"]>,
  receipt: ContractTransactionReceipt,
  quotedOut: bigint,
  minimumOut: bigint,
) {
  // Our own Swap event identifies the pool, so the pool address is never
  // assumed — a different fee tier changes it.
  const ourSwapLog = receipt.logs.find((log) => log.topics[0] === UNISWAP_V3_SWAP_TOPIC);

  let actualBuyAmount = quotedOut;
  let poolAddress: string | null = null;

  if (ourSwapLog) {
    poolAddress = ourSwapLog.address;
    // amount0 and amount1 are int256, signed from the pool's perspective:
    // negative is the token leaving the pool, i.e. what we received.
    const amount0 = BigInt.asIntN(256, BigInt("0x" + ourSwapLog.data.slice(2, 66)));
    const amount1 = BigInt.asIntN(256, BigInt("0x" + ourSwapLog.data.slice(66, 130)));
    const received = amount0 < 0n ? -amount0 : amount1 < 0n ? -amount1 : 0n;
    if (received > 0n) actualBuyAmount = received;
  }

  const versusQuoteBps =
    quotedOut > 0n
      ? Number(((actualBuyAmount - quotedOut) * 10_000n) / quotedOut)
      : 0;

  const budget = quotedOut - minimumOut;
  const consumed = quotedOut - actualBuyAmount;
  const slippageBudgetUsedPercent =
    budget > 0n && consumed > 0n
      ? Math.min(100, Number((consumed * 100n) / budget))
      : 0;

  let otherSwapsOnPoolInBlock = 0;
  let sandwichPatternObserved = false;

  if (poolAddress) {
    const logs = await provider.getLogs({
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
      address: poolAddress,
      topics: [UNISWAP_V3_SWAP_TOPIC],
    });

    const others = logs.filter(
      (log) => log.transactionHash.toLowerCase() !== receipt.hash.toLowerCase(),
    );
    otherSwapsOnPoolInBlock = others.length;

    // A sandwich is not merely "someone else traded here". It needs one trade
    // ordered before ours and another after, in the same block, on the same
    // pool. Reporting anything looser would cry wolf on ordinary contention.
    const ourIndex = Number(receipt.index);
    sandwichPatternObserved =
      others.some((log) => Number(log.transactionIndex) < ourIndex) &&
      others.some((log) => Number(log.transactionIndex) > ourIndex);
  }

  return {
    actualBuyAmount: actualBuyAmount.toString(),
    versusQuoteBps,
    slippageBudgetUsedPercent,
    otherSwapsOnPoolInBlock,
    sandwichPatternObserved,
  };
}

export async function unshieldSwapReshield(params: SwapParams): Promise<SwapResult> {
  const { sellAmount } = params;
  const slippageBps = params.slippageBps ?? 100;

  if (sellAmount <= 0n) throw new Error("sellAmount must be positive");

  if (!poiConfigured()) {
    // Fail here, with an explanation, rather than several minutes into proof
    // generation with an opaque POI request error.
    throw new Error(
      "RAILGUN_POI_NODE_URL is not configured. Spending shielded funds on Sepolia " +
        "requires Proof of Innocence merkle proofs from a live POI aggregator node; " +
        "without one, proof generation cannot complete. Shielding and balance " +
        "queries are unaffected. See railgun-sidecar/README.md.",
    );
  }

  const sell = resolveAsset(params.sellToken);
  const buy = resolveAsset(params.buyToken);

  if (sell.address.toLowerCase() === buy.address.toLowerCase()) {
    throw new Error(`sellToken and buyToken are both ${sell.symbol}`);
  }

  const net = networkConfig();
  const relayAdapt = net.railgun.relayAdaptContract;
  const walletId = getWalletId();
  const recipient = get0zkAddress();

  // Check the *spendable* balance, not the total: a note that is in the tree
  // but not yet POI-validated cannot be spent, and the difference is the most
  // common reason a swap fails after a successful shield.
  const spendable = await getShieldedBalance(sell.address, true);
  if (spendable < sellAmount) {
    const total = await getShieldedBalance(sell.address, false);
    throw new Error(
      `Insufficient spendable shielded ${sell.symbol}: need ${sellAmount}, ` +
        `spendable ${spendable} (total shielded ${total}). ` +
        (total >= sellAmount
          ? "The balance exists but is not yet POI-validated; retry once validation completes."
          : "Shield more first via POST /shield."),
    );
  }

  // Railgun deducts its unshield fee before any recipe step runs, so the amount
  // that actually reaches Uniswap is smaller than the amount unshielded.
  // Quoting the gross figure would price a larger trade than can execute, and
  // the recipe would then fail validation with "Specified amount exceeds
  // balance".
  const unshieldFeeBps = getUnshieldFeeBasisPoints();
  const unshieldFee = (sellAmount * unshieldFeeBps) / 10_000n;
  const netSellAmount = sellAmount - unshieldFee;

  if (netSellAmount <= 0n) {
    throw new Error(
      `sellAmount ${sellAmount} is entirely consumed by the ${unshieldFeeBps} bps unshield fee`,
    );
  }

  const quote = await quoteExactInputSingle(
    sell.address,
    buy.address,
    netSellAmount,
    slippageBps,
    params.feeTier,
  );

  console.log(
    `[railgun] unshield ${sellAmount} ${sell.symbol}, fee ${unshieldFee} ` +
      `(${unshieldFeeBps} bps), net ${netSellAmount}`,
  );
  console.log(
    `[railgun] quote: ${netSellAmount} ${sell.symbol} -> ${quote.amountOut} ${buy.symbol} ` +
      `(fee tier ${quote.feeTier}, min ${quote.minimumAmountOut})`,
  );

  const recipe = new UniswapV3SwapRecipe({
    sellERC20Info: { tokenAddress: sell.address, decimals: BigInt(sell.decimals) },
    buyERC20Info: { tokenAddress: buy.address, decimals: BigInt(buy.decimals) },
    feeTier: quote.feeTier,
    minimumAmountOut: quote.minimumAmountOut,
    expectedAmountOut: quote.amountOut,
    relayAdaptContract: relayAdapt,
  });

  const recipeOutput = await recipe.getRecipeOutput({
    networkName: NETWORK,
    railgunAddress: recipient,
    erc20Amounts: [
      { tokenAddress: sell.address, decimals: BigInt(sell.decimals), amount: sellAmount },
    ],
    nfts: [],
  });

  const unshieldERC20Amounts: RailgunERC20Amount[] = [
    { tokenAddress: sell.address, amount: sellAmount },
  ];
  const shieldERC20Recipients: RailgunERC20Recipient[] = [
    { tokenAddress: buy.address, recipientAddress: recipient },
  ];

  const submitter = getSubmitter();
  const feeData = await submitter.provider!.getFeeData();

  const originalGasDetails = {
    evmGasType: 2 as const,
    gasEstimate: 0n,
    maxFeePerGas: feeData.maxFeePerGas ?? 2_000_000_000n,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 1_000_000_000n,
  };

  // --- 1. Gas estimate (dummy proof) --------------------------------------
  console.log("[railgun] estimating gas with a dummy proof");
  const { gasEstimate } = await gasEstimateForUnprovenCrossContractCalls(
    TXID_VERSION,
    NETWORK,
    walletId,
    getEncryptionKey(),
    unshieldERC20Amounts,
    [],
    shieldERC20Recipients,
    [],
    recipeOutput.crossContractCalls,
    originalGasDetails,
    undefined,
    // sendWithPublicWallet: true, because a public EOA broadcasts this rather
    // than a Railgun broadcaster. It pays gas and reveals nothing about the
    // shielded balances involved.
    true,
    recipeOutput.minGasLimit,
  );

  console.log(`[railgun] gas estimate ${gasEstimate}`);

  // --- 2. Real Groth16 proof ----------------------------------------------
  console.log("[railgun] generating cross-contract proof (typically 1-3 minutes)");
  const proofStart = Date.now();

  await generateCrossContractCallsProof(
    TXID_VERSION,
    NETWORK,
    walletId,
    getEncryptionKey(),
    unshieldERC20Amounts,
    [],
    shieldERC20Recipients,
    [],
    recipeOutput.crossContractCalls,
    undefined, // no broadcaster fee: sending with a public wallet
    true,
    undefined, // overallBatchMinGasPrice: unused without a broadcaster
    recipeOutput.minGasLimit,
    (progress: number) => {
      if (Math.round(progress) % 20 === 0) console.log(`[railgun] proof ${Math.round(progress)}%`);
    },
  );

  const proofDurationMs = Date.now() - proofStart;
  console.log(`[railgun] proof generated in ${(proofDurationMs / 1000).toFixed(1)}s`);

  // --- 3. Populate the proved transaction ---------------------------------
  const { transaction } = await populateProvedCrossContractCalls(
    TXID_VERSION,
    NETWORK,
    walletId,
    unshieldERC20Amounts,
    [],
    shieldERC20Recipients,
    [],
    recipeOutput.crossContractCalls,
    undefined,
    true,
    undefined,
    { ...originalGasDetails, gasEstimate },
  );

  // Submission is deliberately the last step and the only part that varies by
  // route: the proof above already commits to the exact unshield amounts, the
  // cross-contract calls, and the reshield recipients, so no route can alter
  // what was authorised.
  const route = createSubmitter(submitter);
  console.log(
    `[railgun] broadcasting via ${submitter.address} over ${route.route}` +
      (route.mempoolExposed ? " (PUBLIC MEMPOOL — sandwichable)" : " (private, no mempool exposure)"),
  );

  const submission = await submitWithOptionalFallback(
    route,
    submitter,
    transaction as TransactionRequest,
  );

  const receipt = (await submitter.provider!.getTransactionReceipt(
    submission.txHash,
  )) as ContractTransactionReceipt;

  if (!receipt || receipt.status !== 1) {
    throw new Error(`Cross-contract transaction ${submission.txHash} reverted`);
  }

  // RelayAdapt catches inner failures and still returns success at the EVM
  // level, encoding the reason in a log. Without this check a failed swap would
  // look like a successful one — the funds are safely re-shielded either way,
  // but reporting it as a completed swap would be false.
  const relayAdaptError = getRelayAdaptTransactionError(
    TXID_VERSION,
    receipt.logs as any,
  );
  if (relayAdaptError) {
    throw new Error(
      `RelayAdapt reported an inner failure in ${receipt.hash}: ${relayAdaptError}. ` +
        `The unshielded funds were returned to the shielded pool.`,
    );
  }

  const execution = await measureExecution(
    submitter.provider!,
    receipt,
    quote.amountOut,
    quote.minimumAmountOut,
  );

  console.log(
    `[railgun] execution ${execution.versusQuoteBps >= 0 ? "+" : ""}` +
      `${execution.versusQuoteBps} bps vs quote, ` +
      `${execution.slippageBudgetUsedPercent}% of the slippage budget used, ` +
      `${execution.otherSwapsOnPoolInBlock} other swap(s) on this pool in block ` +
      `${receipt.blockNumber}` +
      (execution.sandwichPatternObserved ? " — SANDWICH PATTERN PRESENT" : ""),
  );

  return {
    execution,
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    sellSymbol: sell.symbol,
    buySymbol: buy.symbol,
    sellAmount: sellAmount.toString(),
    netSellAmount: netSellAmount.toString(),
    unshieldFee: unshieldFee.toString(),
    quotedBuyAmount: quote.amountOut.toString(),
    minimumBuyAmount: quote.minimumAmountOut.toString(),
    feeTier: quote.feeTier,
    proofDurationMs,
    relayAdaptContract: relayAdapt,
    explorerUrl: explorerTxUrl(receipt.hash),
    recipient0zk: recipient,
    submission: {
      mode: submission.mode,
      route: submission.route,
      mempoolExposed: submission.mempoolExposed,
    },
  };
}
