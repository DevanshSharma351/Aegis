/**
 * Step 2 of the bootstrap: create the session-key approval.
 *
 * Requires the owner key. Writes shared/config/session-key-approval.json and
 * records the derived smart-account address in deployed.json, so the next step
 * (setVaultSessionKey) has a single source of truth for what to bind.
 *
 *   npm run session-key:approve
 */

import { buildApproval, readApproval, vaultAddress, REBALANCE_SELECTOR } from "./sessionKey";
import { APPROVAL_PATH, networkConfig, updateDeployedConfig } from "./config";
import { getPublicClient } from "./clients";
import { writeApproval } from "./sessionKey";
import * as fs from "fs";

export async function approveSessionKey(force = false) {
  if (fs.existsSync(APPROVAL_PATH) && !force) {
    const existing = readApproval();
    console.log("Approval already exists at", APPROVAL_PATH);
    console.log("  smart account :", existing.smartAccount);
    console.log("  session key   :", existing.sessionKeyAddress);
    console.log("  vault         :", existing.vault);
    console.log("\nRe-run with --force to regenerate (this produces a NEW permission id;");
    console.log("the vault's bound account address does not change, so no redeploy is needed).");
    return existing;
  }

  const { chainId } = networkConfig();
  const vault = vaultAddress();

  console.log("Building session-key approval");
  console.log("  vault    :", vault);
  console.log("  selector :", REBALANCE_SELECTOR, "(rebalance(bytes32,bytes))");

  const { approval, accountAddress, sessionKeyAddress } = await buildApproval();

  const record = {
    approval,
    smartAccount: accountAddress,
    sessionKeyAddress,
    vault,
    permissionSelector: REBALANCE_SELECTOR,
    chainId,
    createdAt: new Date().toISOString(),
  };

  writeApproval(record);
  updateDeployedConfig({ smartAccount: accountAddress });

  // The smart account is what the vault must authorise. The session-key EOA
  // never appears as msg.sender, because a UserOperation executes as the
  // account. Printing both together is the cheapest way to stop the two being
  // confused at the next step.
  console.log("\nApproval written to", APPROVAL_PATH);
  console.log("  smart account (bind THIS on the vault):", accountAddress);
  console.log("  session key EOA (signs UserOps, never msg.sender):", sessionKeyAddress);

  const client = await getPublicClient();
  const code = await client.getCode({ address: accountAddress });
  if (!code || code === "0x") {
    console.log(
      "\nNote: the smart account is not deployed yet. That is expected — Kernel\n" +
        "accounts are counterfactual, and the first UserOperation deploys it. The\n" +
        "address is already final, so it is safe to bind now.",
    );
  }

  return record;
}

if (require.main === module) {
  approveSessionKey(process.argv.includes("--force"))
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("[identity] approveSessionKey failed:", error.message);
      process.exit(1);
    });
}
