/**
 * Step 3 of the bootstrap: bind the executing account to the vault.
 *
 * IRREVERSIBLE — AegisVault.setSessionKey reverts on a second call, by design.
 *
 * THE BUG THIS FILE EXISTS TO NOT REPEAT: the previous version bound
 * `sessionKeyAddress`, the session key's EOA. That address is never
 * `msg.sender` for a rebalance. A UserOperation executes with
 * `msg.sender == smartAccount`, so binding the EOA yields a vault that reverts
 * `NotSessionKey()` on every rebalance forever, with no way to correct it
 * because the setter is one-shot.
 *
 * This version binds the smart-account address, reads it back, and refuses to
 * proceed if the value it is about to write disagrees with the approval blob.
 *
 *   npm run session-key:bind            # prompts
 *   npm run session-key:bind -- --yes   # non-interactive (CI, pipeline)
 */

import * as readline from "readline";
import { Address, createWalletClient, http } from "viem";

import { chain, explorerTxUrl, rpcUrls, updateDeployedConfig } from "./config";
import { getPublicClient, ownerAccount } from "./clients";
import { readApproval } from "./sessionKey";
import { VAULT_ABI, readVaultState, vaultAddress } from "./vault";

async function confirm(question: string): Promise<boolean> {
  // Created lazily. The previous version built the readline interface at module
  // scope, so merely importing this file attached a stdin listener and hung any
  // non-interactive process that touched it.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer: string = await new Promise((resolve) => rl.question(question, resolve));
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

export async function setVaultSessionKey(options: { yes?: boolean } = {}) {
  const approval = readApproval();
  const vault = vaultAddress();
  const state = await readVaultState();

  if (approval.vault.toLowerCase() !== vault.toLowerCase()) {
    throw new Error(
      `The approval blob targets vault ${approval.vault} but deployed.json names ${vault}. ` +
        `Re-run 'npm run session-key:approve' against the current deployment.`,
    );
  }

  const owner = ownerAccount();
  if (state.owner.toLowerCase() !== owner.address.toLowerCase()) {
    throw new Error(
      `Vault owner is ${state.owner}, but AEGIS_OWNER_PRIVATE_KEY controls ${owner.address}. ` +
        `Only the owner can bind the session key.`,
    );
  }

  if (state.sessionKeySet) {
    if (state.sessionKey.toLowerCase() === approval.smartAccount.toLowerCase()) {
      console.log("Session key is already bound correctly:", state.sessionKey);
      updateDeployedConfig({ sessionKey: state.sessionKey });
      return { txHash: null, sessionKey: state.sessionKey, alreadyBound: true };
    }
    throw new Error(
      `Vault already has session key ${state.sessionKey} bound, which is NOT the current ` +
        `smart account ${approval.smartAccount}. setSessionKey is one-shot, so this vault ` +
        `cannot be repaired — redeploy the contracts and re-run the bootstrap.`,
    );
  }

  const target = approval.smartAccount as Address;

  console.log("\n=======================================================");
  console.log("IRREVERSIBLE: binding the executing account to AegisVault");
  console.log("=======================================================");
  console.log("  vault              :", vault);
  console.log("  smart account      :", target, "  <- becomes msg.sender for rebalance");
  console.log("  session key EOA    :", approval.sessionKeyAddress, "  (signs UserOps only)");
  console.log("  owner (signing tx) :", owner.address);
  console.log("=======================================================\n");

  if (!options.yes && !(await confirm("Proceed? (yes/no): "))) {
    console.log("Cancelled. Nothing was written on-chain.");
    return { txHash: null, sessionKey: null, alreadyBound: false };
  }

  const publicClient = await getPublicClient();
  const walletClient = createWalletClient({
    account: owner,
    chain: chain(),
    transport: http(rpcUrls()[0]),
  });

  // Simulate first: a revert here costs nothing, whereas a failed transaction
  // costs gas and, for a one-shot setter, can leave an ambiguous state.
  const { request } = await publicClient.simulateContract({
    account: owner,
    address: vault,
    abi: VAULT_ABI,
    functionName: "setSessionKey",
    args: [target],
  });

  const txHash = await walletClient.writeContract(request);
  console.log("Submitted:", txHash);
  console.log(explorerTxUrl(txHash));

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`setSessionKey reverted in block ${receipt.blockNumber}`);
  }

  // Read back rather than trusting the receipt: this is the one write in the
  // system that cannot be retried.
  const after = await readVaultState();
  if (after.sessionKey.toLowerCase() !== target.toLowerCase()) {
    throw new Error(
      `Post-write readback mismatch: vault reports ${after.sessionKey}, expected ${target}.`,
    );
  }

  updateDeployedConfig({ sessionKey: after.sessionKey });
  console.log(`\nBound and verified in block ${receipt.blockNumber}: ${after.sessionKey}`);

  return { txHash, sessionKey: after.sessionKey, alreadyBound: false };
}

if (require.main === module) {
  setVaultSessionKey({ yes: process.argv.includes("--yes") })
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("[identity] setVaultSessionKey failed:", error.message);
      process.exit(1);
    });
}
