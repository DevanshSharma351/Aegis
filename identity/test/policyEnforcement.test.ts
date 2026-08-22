/**
 * Session-key policy tests.
 *
 * The previous versions of these tests built a policy object and asserted
 * `expect(policy).toBeDefined()`. That passes for any value the SDK returns,
 * including a policy scoped to the wrong function — which is precisely the bug
 * that was live in `policy.json` (selector `0x7f1a1e28` for a function whose
 * real selector is `0xe7ef57de`) and which nothing caught.
 *
 * These check the properties that actually matter: that the declared policy
 * matches the compiled contract, and that the encoded policy data commits to
 * the target and selector we think it does.
 *
 * WHERE ENFORCEMENT ACTUALLY HAPPENS: on-chain, in the ZeroDev permission
 * validator, during `EntryPoint.validateUserOp`. A UserOperation violating the
 * target, selector, value limit, or rate limit is rejected by the account
 * itself, before execution. Nothing here is the real backstop — these tests
 * verify that the policy we ship to that validator is the one we intended.
 */

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { getAbiItem, toFunctionSelector } from "viem";
import { CallPolicyVersion, toCallPolicy } from "@zerodev/permissions/policies";

const ROOT = path.resolve(__dirname, "../..");

function readJson<T>(...segments: string[]): T {
  const file = path.join(ROOT, ...segments);
  return JSON.parse(fs.readFileSync(file, "utf-8").replace(/^﻿/, "")) as T;
}

const policy = readJson<any>("shared", "config", "policy.json").sessionKeyPolicy;
const vaultAbi = readJson<any[]>("shared", "abi", "AegisVault.json");

describe("session-key policy vs. the compiled contract", () => {
  it("declares a selector that matches the deployed ABI", () => {
    const declared = policy.allowedSelectors.find((e: any) => e.target === "AegisVault");
    expect(declared).toBeDefined();

    const fn = vaultAbi.find((e) => e.type === "function" && e.name === "rebalance");
    expect(fn).toBeDefined();

    const actualSignature = `rebalance(${fn.inputs.map((i: any) => i.type).join(",")})`;
    expect(declared.signature).toBe(actualSignature);
    expect(declared.selector.toLowerCase()).toBe(toFunctionSelector(actualSignature).toLowerCase());
  });

  it("scopes the key to exactly one function", () => {
    expect(policy.allowedSelectors).toHaveLength(1);
  });

  it("forbids attaching any native value", () => {
    // Three independent controls stop fund movement; this is the first, and the
    // only one expressible in the session-key policy itself.
    expect(policy.valueLimitWei).toBe("0");
    expect(BigInt(policy.valueLimitWei)).toBe(0n);
  });

  it("permits exactly one execution per day", () => {
    expect(policy.maxExecutionsPerDay).toBe(1);
    expect(policy.rateLimitIntervalSeconds).toBe(86400);
  });

  it("declares no withdrawal permissions", () => {
    expect(policy.withdrawalPermissions).toBe("NONE");
  });
});

describe("the vault the policy points at", () => {
  it("exposes no function that can move value", () => {
    // The policy would be worthless if the single reachable contract had a
    // transfer function, so this is checked here as well as in Solidity.
    const dangerous = ["withdraw", "transfer", "transferFrom", "send", "sweep", "rescue", "execute"];
    const functionNames = vaultAbi
      .filter((e) => e.type === "function")
      .map((e) => e.name.toLowerCase());

    for (const name of dangerous) {
      expect(functionNames).not.toContain(name);
    }
  });

  it("has no payable function", () => {
    const payable = vaultAbi.filter(
      (e) => e.type === "function" && e.stateMutability === "payable",
    );
    expect(payable).toHaveLength(0);
  });

  it("has no receive or fallback", () => {
    const catchAll = vaultAbi.filter((e) => e.type === "receive" || e.type === "fallback");
    expect(catchAll).toHaveLength(0);
  });

  it("emits an event carrying no amount data", () => {
    const event = vaultAbi.find((e) => e.type === "event" && e.name === "RebalanceExecuted");
    expect(event).toBeDefined();

    const fields = event.inputs.map((i: any) => i.name).sort();
    expect(fields).toEqual(["decisionHash", "sequence", "timestamp"]);

    // No field named or typed like a token amount.
    for (const input of event.inputs) {
      expect(input.name.toLowerCase()).not.toMatch(/amount|balance|value|alloc/);
    }
  });
});

describe("the encoded call policy", () => {
  const vault = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as const;

  const buildPolicy = () =>
    toCallPolicy({
      policyVersion: policy.callPolicyVersion as CallPolicyVersion,
      permissions: [
        {
          target: vault,
          valueLimit: BigInt(policy.valueLimitWei),
          abi: vaultAbi as any,
          functionName: "rebalance",
        },
      ],
    });

  it("encodes policy data committing to the target address", async () => {
    const data = await buildPolicy().getPolicyData({} as any);

    expect(data).toMatch(/^0x[0-9a-fA-F]+$/);
    // The target must appear in the encoded permission, or the on-chain
    // validator would not be constraining it.
    expect(data.toLowerCase()).toContain(vault.slice(2).toLowerCase());
  });

  it("encodes policy data committing to the rebalance selector", async () => {
    const data = await buildPolicy().getPolicyData({} as any);
    const selector = toFunctionSelector("rebalance(bytes32,bytes)").slice(2);

    expect(data.toLowerCase()).toContain(selector.toLowerCase());
  });

  it("produces a different policy for a different target", async () => {
    const other = "0x1111111111111111111111111111111111111111" as const;
    const otherPolicy = toCallPolicy({
      policyVersion: policy.callPolicyVersion as CallPolicyVersion,
      permissions: [
        {
          target: other,
          valueLimit: 0n,
          abi: vaultAbi as any,
          functionName: "rebalance",
        },
      ],
    });

    const a = await buildPolicy().getPolicyData({} as any);
    const b = await otherPolicy.getPolicyData({} as any);
    expect(a).not.toBe(b);
  });

  it("rejects a function the ABI does not declare", () => {
    expect(() =>
      toCallPolicy({
        policyVersion: policy.callPolicyVersion as CallPolicyVersion,
        permissions: [
          {
            target: vault,
            valueLimit: 0n,
            abi: vaultAbi as any,
            functionName: "withdraw" as any,
          },
        ],
      }),
    ).toThrow();
  });

  it("uses a call policy version the SDK ships", () => {
    expect(Object.values(CallPolicyVersion)).toContain(policy.callPolicyVersion);
  });
});
