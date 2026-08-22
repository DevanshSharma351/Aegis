/**
 * Session-key construction and the approve/execute split.
 *
 * THE SPLIT MATTERS. A ZeroDev permission validator has to be *enabled* on the
 * Kernel account, and enabling it requires a signature from the account's sudo
 * (owner) validator. There are two ways to arrange that:
 *
 *   (a) Attach `{ sudo: ownerValidator, regular: permissionValidator }` on every
 *       submission. Works, but the owner key must be present in the signing
 *       process every single time — which means the "session key" provides no
 *       isolation at all. This is what the previous implementation did.
 *
 *   (b) Do it once: build the account with both plugins, serialise it (the blob
 *       carries the owner's enable signature), and store that. Afterwards, load
 *       the blob with only the session-key signer. The owner key is never
 *       needed again.
 *
 * (b) is what this file implements. `buildApproval` runs once with the owner
 * online; `loadSessionKeyAccount` runs on every rebalance with only
 * SESSION_KEY_PRIVATE_KEY available.
 *
 * The approval blob is not a secret — it is an enable signature scoped to a
 * specific permission id. Without the session key's private key it cannot
 * authorise anything, which is why it can live in shared/config.
 */

import * as fs from "fs";
import { Address, Hex, toFunctionSelector } from "viem";
import { createKernelAccount } from "@zerodev/sdk";
import {
  deserializePermissionAccount,
  serializePermissionAccount,
  toPermissionValidator,
} from "@zerodev/permissions";
import { CallPolicyVersion, toCallPolicy, toRateLimitPolicy } from "@zerodev/permissions/policies";
import { toECDSASigner } from "@zerodev/permissions/signers";

import { ENTRY_POINT, KERNEL_VERSION, getEcdsaValidator, getPublicClient, sessionKeyAccount } from "./clients";
import { APPROVAL_PATH, deployedConfig, policyConfig, requireAddress } from "./config";

/** ABI fragment the call policy is scoped to. Must match AegisVault exactly. */
export const REBALANCE_ABI = [
  {
    type: "function",
    name: "rebalance",
    inputs: [
      { name: "decisionHash", type: "bytes32" },
      { name: "attestationProof", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export const REBALANCE_SELECTOR = toFunctionSelector(
  "rebalance(bytes32,bytes)",
) as Hex;

/**
 * Cross-check the policy file against the ABI this code actually uses.
 *
 * The selector in policy.json was wrong (0x7f1a1e28 for a function whose
 * selector is 0xe7ef57de) and nothing caught it, because nothing compared the
 * two. Now a mismatch fails loudly at startup instead of producing a session key
 * scoped to a function that does not exist.
 */
export function assertPolicyMatchesAbi(): void {
  const policy = policyConfig().sessionKeyPolicy;
  const declared = policy.allowedSelectors.find((entry) => entry.target === "AegisVault");

  if (!declared) {
    throw new Error("policy.json declares no allowed selector targeting AegisVault");
  }
  if (declared.selector.toLowerCase() !== REBALANCE_SELECTOR.toLowerCase()) {
    throw new Error(
      `policy.json selector ${declared.selector} does not match the compiled ` +
        `rebalance(bytes32,bytes) selector ${REBALANCE_SELECTOR}. ` +
        `Fix shared/config/policy.json before generating a session key.`,
    );
  }
  if (policy.valueLimitWei !== "0") {
    throw new Error(
      `policy.json valueLimitWei is ${policy.valueLimitWei}, expected "0". ` +
        `The session key must never be able to attach ETH to a call.`,
    );
  }
}

export function vaultAddress(): Address {
  return requireAddress(deployedConfig().AegisVault, "deployed.json AegisVault");
}

/**
 * The permission validator: an ECDSA session-key signer plus its policies.
 *
 * Policies are enforced on-chain by the Kernel permission module during
 * `validateUserOp`. They are not advisory client-side checks — a UserOperation
 * violating any of them is rejected by the account itself, before execution.
 */
export async function buildPermissionValidator() {
  assertPolicyMatchesAbi();

  const publicClient = await getPublicClient();
  const policy = policyConfig().sessionKeyPolicy;
  const target = vaultAddress();

  const signer = await toECDSASigner({ signer: sessionKeyAccount() as any });

  const callPolicy = toCallPolicy({
    policyVersion: policy.callPolicyVersion as CallPolicyVersion,
    permissions: [
      {
        target,
        valueLimit: BigInt(policy.valueLimitWei),
        abi: REBALANCE_ABI,
        functionName: "rebalance",
      },
    ],
  });

  const rateLimitPolicy = toRateLimitPolicy({
    count: policy.maxExecutionsPerDay,
    interval: policy.rateLimitIntervalSeconds,
  });

  const validator = await toPermissionValidator(publicClient, {
    signer,
    policies: [callPolicy, rateLimitPolicy],
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
  });

  return { validator, signer, target, policy };
}

/**
 * One-time: produce the approval blob (owner must be available).
 *
 * The returned string embeds the owner's enable signature for this exact
 * permission id. Regenerating it with different policies produces a different
 * permission id, so an old blob cannot be used to widen a key's scope.
 */
export async function buildApproval(): Promise<{
  approval: string;
  accountAddress: Address;
  sessionKeyAddress: Address;
}> {
  const publicClient = await getPublicClient();
  const ecdsaValidator = await getEcdsaValidator();
  const { validator } = await buildPermissionValidator();

  const account = await createKernelAccount(publicClient, {
    plugins: { sudo: ecdsaValidator, regular: validator },
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
  });

  const approval = await serializePermissionAccount(account);

  return {
    approval,
    accountAddress: account.address,
    sessionKeyAddress: sessionKeyAccount().address,
  };
}

export interface StoredApproval {
  approval: string;
  smartAccount: Address;
  sessionKeyAddress: Address;
  vault: Address;
  permissionSelector: Hex;
  chainId: number;
  createdAt: string;
}

export function readApproval(): StoredApproval {
  if (!fs.existsSync(APPROVAL_PATH)) {
    throw new Error(
      `Session-key approval not found at ${APPROVAL_PATH}. ` +
        `Run: npm run session-key:approve`,
    );
  }
  return JSON.parse(fs.readFileSync(APPROVAL_PATH, "utf-8").replace(/^﻿/, ""));
}

export function writeApproval(record: StoredApproval): void {
  fs.writeFileSync(APPROVAL_PATH, JSON.stringify(record, null, 2) + "\n", "utf-8");
}

/**
 * Execution path: rebuild the account from the stored approval, signing with
 * the session key alone. AEGIS_OWNER_PRIVATE_KEY is not read here.
 */
export async function loadSessionKeyAccount() {
  const publicClient = await getPublicClient();
  const stored = readApproval();

  const currentVault = vaultAddress();
  if (stored.vault.toLowerCase() !== currentVault.toLowerCase()) {
    throw new Error(
      `Stored approval is scoped to vault ${stored.vault}, but deployed.json now ` +
        `names ${currentVault}. Re-run the approval step after a redeploy.`,
    );
  }

  const signer = await toECDSASigner({ signer: sessionKeyAccount() as any });

  const account = await deserializePermissionAccount(
    publicClient,
    ENTRY_POINT,
    KERNEL_VERSION,
    stored.approval,
    signer,
  );

  if (account.address.toLowerCase() !== stored.smartAccount.toLowerCase()) {
    throw new Error(
      `Deserialised account ${account.address} does not match the recorded ` +
        `${stored.smartAccount}. The approval blob does not belong to this configuration.`,
    );
  }

  return { account, stored };
}
