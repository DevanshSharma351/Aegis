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

import { ContractTransactionReceipt, TransactionRequest } from "ethers";
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

  return {
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
