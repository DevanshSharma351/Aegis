/**
 * Submit an attested rebalance as an ERC-4337 UserOperation.
 *
 * Signs with the session key only. AEGIS_OWNER_PRIVATE_KEY is never read on
 * this path — see sessionKey.ts for why that required the approve/execute
 * split.
 */

import { Hex } from "viem";

import { explorerTxUrl, policyConfig } from "./config";
import { buildKernelClient } from "./clients";
import { loadSessionKeyAccount, readApproval } from "./sessionKey";
import {
  encodeRebalance,
  extractRebalanceEvents,
  isDecisionExecuted,
  readVaultState,
  vaultAddress,
} from "./vault";

export interface SubmitResult {
  userOpHash: Hex;
  txHash: Hex;
  blockNumber: string;
  gasUsed: string;
  smartAccount: string;
  decisionHash: Hex;
  sequence: string;
  timestamp: string;
  explorerUrl: string;
}

function normaliseHex(value: string, name: string, byteLength?: number): Hex {
  const hex = (value.startsWith("0x") ? value : `0x${value}`) as Hex;
  if (!/^0x[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`${name} is not hex: ${value}`);
  }
  if (byteLength !== undefined && hex.length !== 2 + byteLength * 2) {
    throw new Error(`${name} must be ${byteLength} bytes, got ${(hex.length - 2) / 2}`);
  }
  return hex;
}

/**
 * Error selector returned by the ZeroDev rate-limit policy when a permission's
 * allowance for the current interval is exhausted.
 *
 * The bundler surfaces this as `AA23 reverted <selector><word>` inside a viem
 * error whose printed form is several hundred characters of callData — which is
 * what reached the UI. The condition is ordinary and expected (the policy is
 * doing its job), so it deserves a sentence, not a hex dump.
 */
const RATE_LIMIT_POLICY_ERROR = "0x3e4983f6";

/**
 * Translate bundler simulation failures into something a human can act on.
 *
 * Only conditions that are *diagnosable from the selector* are rewritten.
 * Anything else is rethrown untouched: inventing a friendly explanation for an
 * error we have not identified would be worse than the raw text, because it
 * would send the reader somewhere confidently wrong.
 */
function explainValidationFailure(error: Error): Error {
  const text = `${error.message}`;

  if (text.includes("AA23") && text.toLowerCase().includes(RATE_LIMIT_POLICY_ERROR)) {
    const { maxExecutionsPerDay, rateLimitIntervalSeconds } = policyConfig().sessionKeyPolicy;
    const hours = Math.round(rateLimitIntervalSeconds / 3600);
    return new Error(
      `Session-key rate limit reached: the policy permits ${maxExecutionsPerDay} ` +
        `execution(s) per ${hours}h and the allowance for this window is spent. ` +
        `Nothing was submitted and no gas was used. Either wait for the window to ` +
        `roll over, or — with the owner key, on the host — issue a new session key: ` +
        `npx tsx src/approveSessionKey.ts --rotate. Rotation needs the owner because ` +
        `the new permission id requires the owner's enable signature; the identity ` +
        `service cannot do it alone, which is what makes this limit meaningful.`,
    );
  }

  if (text.includes("AA21") || text.toLowerCase().includes("does not have sufficient funds")) {
    return new Error(
      `Smart account ${readApproval().smartAccount} cannot prefund the UserOperation. ` +
        `ERC-4337 requires the account to hold gas x maxFeePerGas up front, even though ` +
        `the unused portion is refunded. Nothing was submitted. Fund the account and retry.`,
    );
  }

  return error;
}

/**
 * Submit `AegisVault.rebalance(decisionHash, attestationProof)`.
 *
 * Pre-flight checks run before anything is signed, because a UserOperation that
 * reverts on-chain still costs the paymaster gas and produces a far less
 * legible error than a local check does.
 */
export async function submitRebalance(
  decisionHashRaw: string,
  attestationProofRaw: string,
): Promise<SubmitResult> {
  const decisionHash = normaliseHex(decisionHashRaw, "decisionHash", 32);
  const attestationProof = normaliseHex(attestationProofRaw, "attestationProof");

  const vault = vaultAddress();
  const { account, stored } = await loadSessionKeyAccount();

  // Pre-flight 1: is the vault bound to this account at all?
  const state = await readVaultState();
  if (!state.sessionKeySet) {
    throw new Error(
      `Vault ${vault} has no session key bound. Run: npm run session-key:bind`,
    );
  }
  if (state.sessionKey.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(
      `Vault is bound to ${state.sessionKey}, but this approval yields account ` +
        `${account.address}. Every rebalance would revert with NotSessionKey(). ` +
        `The vault's setter is one-shot, so this needs a redeploy.`,
    );
  }

  // Pre-flight 2: the on-chain replay guard.
  if (await isDecisionExecuted(decisionHash)) {
    throw new Error(
      `Decision ${decisionHash} has already been executed on this vault. ` +
        `Each decision may be recorded exactly once.`,
    );
  }

  const kernelClient = await buildKernelClient(account);
  const callData = encodeRebalance(decisionHash, attestationProof);

  console.error(`[identity] account      ${account.address}`);
  console.error(`[identity] vault        ${vault}`);
  console.error(`[identity] decisionHash ${decisionHash}`);
  console.error(`[identity] proof        ${(attestationProof.length - 2) / 2} bytes`);

  let userOpHash: Hex;
  try {
    userOpHash = await kernelClient.sendUserOperation({
      callData: await account.encodeCalls([{ to: vault, value: 0n, data: callData }]),
    });
  } catch (error) {
    throw explainValidationFailure(error as Error);
  }
  console.error(`[identity] userOpHash   ${userOpHash}`);

  const receipt = await kernelClient.waitForUserOperationReceipt({
    hash: userOpHash,
    timeout: 180_000,
  });

  if (!receipt.success) {
    throw new Error(
      `UserOperation ${userOpHash} reverted on-chain (tx ${receipt.receipt.transactionHash}). ` +
        `Reasons in order of likelihood: attestation expired, measurement mismatch between ` +
        `the enclave build and AttestationVerifier.expectedMeasurement, or the daily rate ` +
        `limit already consumed.`,
    );
  }

  // Confirm the event rather than inferring success from the receipt status:
  // a transaction can succeed while the log we care about is absent.
  const events = extractRebalanceEvents(receipt.receipt.logs);
  const event = events.find((e) => e.decisionHash.toLowerCase() === decisionHash.toLowerCase());
  if (!event) {
    throw new Error(
      `Transaction ${receipt.receipt.transactionHash} succeeded but emitted no ` +
        `RebalanceExecuted for ${decisionHash}.`,
    );
  }

  const txHash = receipt.receipt.transactionHash as Hex;
  console.error(`[identity] Tx Hash:     ${txHash}`);
  console.error(`[identity] sequence     ${event.sequence}`);

  return {
    userOpHash: userOpHash as Hex,
    txHash,
    blockNumber: receipt.receipt.blockNumber.toString(),
    gasUsed: receipt.receipt.gasUsed.toString(),
    smartAccount: stored.smartAccount,
    decisionHash,
    sequence: event.sequence.toString(),
    timestamp: event.timestamp.toString(),
    explorerUrl: explorerTxUrl(txHash),
  };
}

if (require.main === module) {
  const decisionHash = process.env.DECISION_HASH ?? process.argv[2];
  const proof = process.env.ATTESTATION_PROOF ?? process.argv[3];

  if (!decisionHash || !proof) {
    console.error(
      "Usage: submitUserOp <decisionHash> <attestationProof>\n" +
        "   or: DECISION_HASH=0x.. ATTESTATION_PROOF=0x.. npm run submit",
    );
    process.exit(1);
  }

  submitRebalance(decisionHash, proof)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((error) => {
      console.error("[identity] submit failed:", error.message);
      process.exit(1);
    });
}
