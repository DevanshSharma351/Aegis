/**
 * Unshielding: move a shielded balance back out to a public address.
 *
 * This is the counterpart to shield.ts, and the reason it exists is not
 * symmetry for its own sake. Without it, anything deposited into the agent's
 * shielded pool is unrecoverable by anyone -- there was no code path that could
 * move it out except the atomic swap recipe, which only ever reshields. A
 * deposit flow that users sign with their own wallet cannot honestly ship
 * against a pool with no exit.
 *
 * Unlike a shield, this needs a real Groth16 proof: the shielded side is a
 * commitment tree, and spending from it means proving ownership of a note
 * without revealing which one. That is the same machinery the swap uses, minus
 * the cross-contract calls, so it takes the same order of time.
 */

import { ContractTransactionReceipt, TransactionRequest, isAddress } from "ethers";
import {
  gasEstimateForUnprovenUnshield,
  generateUnshieldProof,
  populateProvedUnshield,
} from "@railgun-community/wallet";
import { RailgunERC20AmountRecipient, TXIDVersion } from "@railgun-community/shared-models";

import { explorerTxUrl, resolveAsset } from "./config";
import { NETWORK_NAME, poiConfigured } from "./engine";
import { createSubmitter, submitWithOptionalFallback } from "./submission";
import {
  getEncryptionKey,
  getShieldedBalance,
  getSubmitter,
  getWalletId,
  scanBalances,
} from "./wallet";

const TXID_VERSION = TXIDVersion.V2_PoseidonMerkle;
const NETWORK = NETWORK_NAME;

export interface UnshieldResult {
  txHash: string;
  blockNumber: number;
  gasUsed: string;
  token: string;
  symbol: string;
  /** Requested amount, before Railgun's unshield fee. */
  amount: string;
  /** What the recipient actually receives, after the fee. */
  netAmount: string;
  unshieldFee: string;
  recipient: string;
  proofDurationMs: number;
  explorerUrl: string;
  submission: { mode: string; route: string; mempoolExposed: boolean };
}

/** ERC-20 `Transfer(address,address,uint256)`. */
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Sum the token actually delivered to `recipient` in this transaction.
 *
 * Railgun splits an unshield into a payment to the recipient and a fee to the
 * treasury, so the recipient's leg alone is the payout.
 */
function erc20AmountReceived(
  receipt: ContractTransactionReceipt,
  tokenAddress: string,
  recipient: string,
): bigint {
  const token = tokenAddress.toLowerCase();
  const to = recipient.toLowerCase();

  return receipt.logs.reduce((total, log) => {
    if (log.address.toLowerCase() !== token) return total;
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3) return total;
    if ("0x" + log.topics[2].slice(-40).toLowerCase() !== to) return total;
    return total + BigInt(log.data);
  }, 0n);
}

/**
 * Turn a stale-engine revert into something a caller can act on.
 *
 * The engine's view of the commitment tree trails the chain by roughly 30-60s
 * after any spend. Inside that window `/balances` still reports the pre-spend
 * figure, and the next spend selects a note that is already consumed -- which
 * surfaces from eth_estimateGas as `RailgunLogic: Note already spent`, a
 * message that reads like corruption when the real answer is "wait a moment".
 *
 * Measured: a 20 USDC unshield left the reported balance unchanged at 30s,
 * then corrected by exactly the spent amount by 60s.
 */
async function withSpentNoteGuard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (/note already spent/i.test((error as Error).message ?? "")) {
      throw new Error(
        "The shielded balance is still syncing after a recent spend, so this " +
          "would have spent a note that is already consumed. Nothing was " +
          "submitted and no gas was used. The engine catches up within about a " +
          "minute -- wait and retry. Balances shown before then are pre-spend.",
      );
    }
    throw error;
  }
}

/**
 * Unshield `amount` of a token to a public address.
 *
 * The recipient is an ordinary EVM address and is public: an unshield is
 * visible on-chain as a withdrawal to that address. What stays private is the
 * history of the note being spent, which is the whole point of the pool.
 *
 * `recipientAddress` is always supplied by the caller and never defaulted here.
 * The browser passes the connected account, so a withdrawal goes where the
 * person who asked for it says — this function has no notion of a "default"
 * wallet to fall back to.
 */
export async function unshield(
  tokenReference: string,
  amount: bigint,
  recipientAddress: string,
): Promise<UnshieldResult> {
  if (amount <= 0n) throw new Error("unshield amount must be positive");

  if (!isAddress(recipientAddress)) {
    throw new Error(
      `recipient ${recipientAddress} is not a valid address. An unshield sends funds to ` +
        `a public EVM address, not to a 0zk address.`,
    );
  }

  if (!poiConfigured()) {
    throw new Error(
      "RAILGUN_POI_NODE_URL is not configured. Spending shielded funds requires a POI " +
        "aggregator, so an unshield cannot produce a proof.",
    );
  }

  const asset = resolveAsset(tokenReference);
  const walletId = getWalletId();
  const submitter = getSubmitter();

  // Check spendability before spending minutes on a proof. `spendable` is the
  // POI-validated balance, which is what can actually be proven -- the total
  // includes notes still awaiting validation.
  const [totalBefore, spendable] = await Promise.all([
    getShieldedBalance(asset.address, false),
    getShieldedBalance(asset.address, true),
  ]);

  if (spendable < amount) {
    throw new Error(
      `Insufficient POI-validated ${asset.symbol}: need ${amount}, spendable ` +
        `${spendable} (total shielded ${totalBefore}). A note becomes spendable once ` +
        `the aggregator validates it, which takes a few minutes after a shield or a ` +
        `reshield.`,
    );
  }

  const erc20AmountRecipients: RailgunERC20AmountRecipient[] = [
    {
      tokenAddress: asset.address,
      amount,
      recipientAddress,
    },
  ];

  const feeData = await submitter.provider!.getFeeData();
  const originalGasDetails = {
    evmGasType: 2 as const,
    gasEstimate: 0n,
    maxFeePerGas: feeData.maxFeePerGas ?? 2_000_000_000n,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 1_000_000_000n,
  };

  console.log(`[railgun] estimating unshield gas for ${amount} ${asset.symbol}`);
  const { gasEstimate } = await withSpentNoteGuard(() =>
    gasEstimateForUnprovenUnshield(
      TXID_VERSION,
      NETWORK,
      walletId,
      getEncryptionKey(),
      erc20AmountRecipients,
      [],
      originalGasDetails,
      undefined,
      // A public EOA broadcasts this rather than a Railgun broadcaster. It pays
      // gas and learns nothing about the shielded side beyond what the unshield
      // itself reveals.
      true,
    ),
  );

  console.log("[railgun] generating unshield proof (typically 1-3 minutes)");
  const proofStart = Date.now();

  await generateUnshieldProof(
    TXID_VERSION,
    NETWORK,
    walletId,
    getEncryptionKey(),
    erc20AmountRecipients,
    [],
    undefined, // no broadcaster fee: sending with a public wallet
    true,
    undefined, // overallBatchMinGasPrice: unused without a broadcaster
    (progress: number) => {
      if (Math.round(progress) % 20 === 0) console.log(`[railgun] proof ${Math.round(progress)}%`);
    },
  );

  const proofDurationMs = Date.now() - proofStart;
  console.log(`[railgun] proof generated in ${(proofDurationMs / 1000).toFixed(1)}s`);

  const { transaction } = await populateProvedUnshield(
    TXID_VERSION,
    NETWORK,
    walletId,
    erc20AmountRecipients,
    [],
    undefined,
    true,
    undefined,
    { ...originalGasDetails, gasEstimate },
  );

  const route = createSubmitter(submitter);
  const submission = await submitWithOptionalFallback(
    route,
    submitter,
    transaction as TransactionRequest,
  );

  const receipt = (await submitter.provider!.getTransactionReceipt(
    submission.txHash,
  )) as ContractTransactionReceipt;

  if (!receipt || receipt.status !== 1) {
    throw new Error(`Unshield transaction ${submission.txHash} reverted`);
  }

  // Nudge the engine to re-derive balances rather than waiting for its own
  // poll, so the reported position reflects this spend sooner. Best effort:
  // the withdrawal has already landed, and failing to refresh a cache is not a
  // reason to report a completed transfer as failed.
  await scanBalances().catch(() => undefined);

  // Report what the recipient actually received, read from the token's own
  // Transfer events in this receipt. Railgun deducts its unshield fee from the
  // amount, so quoting the request would overstate the payout.
  //
  // Deriving it from a shielded-balance diff instead looked reasonable and was
  // wrong: the engine rescans asynchronously and the spend also creates a
  // change note, so a read taken straight after the transaction does not
  // isolate this withdrawal. It reported a 22.8% fee on a transfer whose real
  // fee was 0.25%. The receipt is authoritative and needs no rescan.
  const netAmount = erc20AmountReceived(receipt, asset.address, recipientAddress);
  const fee = amount > netAmount ? amount - netAmount : 0n;

  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    token: asset.address,
    symbol: asset.symbol,
    amount: amount.toString(),
    netAmount: netAmount.toString(),
    unshieldFee: fee.toString(),
    recipient: recipientAddress,
    proofDurationMs,
    explorerUrl: explorerTxUrl(receipt.hash),
    submission: {
      mode: submission.mode,
      route: submission.route,
      mempoolExposed: submission.mempoolExposed,
    },
  };
}
