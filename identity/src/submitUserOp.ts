import { getAccount } from "./createAccount";
import { Hex, encodeFunctionData } from "viem";

/**
 * Submits a UserOperation to the bundler using the owner's Kernel smart account.
 * 
 * In production, this should use a session-key-scoped permission validator so
 * the owner key never touches the hot path. For now we use the owner ECDSA
 * validator directly because the ZeroDev permissions SDK has compatibility
 * issues with the installed version.
 */
export async function submitUserOp(
  targetAddress: Hex,
  calldata: Hex,
  value: bigint = 0n,
) {
  const { account, kernelClient } = await getAccount();

  console.log(`[identity] Kernel Smart Account: ${account.address}`);
  console.log(`[identity] Submitting UserOp to target: ${targetAddress}`);

  // Use sendTransaction — the kernelClient handles UserOp encoding internally
  const txHash = await kernelClient.sendTransaction({
    to: targetAddress,
    data: calldata,
    value,
  });

  console.log(`[identity] Transaction Mined! Tx Hash: ${txHash}`);
  return txHash;
}

// ---------------------------------------------------------------------------
// Hex normalisation helper — adds 0x prefix if missing
// ---------------------------------------------------------------------------
function ensureHex(value: string | undefined): Hex {
  if (!value) throw new Error("Value is undefined");
  return (value.startsWith("0x") ? value : `0x${value}`) as Hex;
}

// ---------------------------------------------------------------------------
// CLI execution — called by run_full_pipeline.sh via `npm run start:submit`
// ---------------------------------------------------------------------------
if (require.main === module) {
  // All values come from environment variables injected by the pipeline script
  const rawTarget = process.env.AEGIS_VAULT_ADDRESS;
  const rawDecisionHash = process.env.DECISION_HASH;
  const rawTdxQuote = process.env.TDX_QUOTE;

  if (!rawTarget || !rawDecisionHash || !rawTdxQuote) {
    console.error(
      "[identity] Missing env vars. Required: AEGIS_VAULT_ADDRESS, DECISION_HASH, TDX_QUOTE",
    );
    process.exit(1);
  }

  const target = ensureHex(rawTarget);
  const decisionHash = ensureHex(rawDecisionHash);
  const tdxQuote = ensureHex(rawTdxQuote);

  console.log(`[identity] target=${target}`);
  console.log(`[identity] decisionHash=${decisionHash}`);
  console.log(`[identity] tdxQuote length=${tdxQuote.length} chars`);

  // Encode the calldata for AegisVault.rebalance(bytes32, bytes)
  const calldata = encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "rebalance",
        inputs: [
          { name: "decisionHash", type: "bytes32" },
          { name: "proof", type: "bytes" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
      },
    ],
    functionName: "rebalance",
    args: [decisionHash, tdxQuote],
  });

  submitUserOp(target, calldata)
    .then((txHash) => {
      console.log(`Transaction Mined! Tx Hash: ${txHash}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("[identity] Fatal error:", err);
      if (err.details) console.error("[identity] Details:", err.details);
      process.exit(1);
    });
}
