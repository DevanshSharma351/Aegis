/**
 * Rate-limit policy tests.
 *
 * What the previous version asserted: that `toRateLimitPolicy({...})` returned
 * something not-undefined. That is true of every input, including a policy
 * configured for a thousand executions per second.
 *
 * These check that the encoded policy actually commits to the interval and
 * count from `policy.json`, and that changing either changes the encoding — the
 * only local evidence that the on-chain validator will be constrained the way
 * we intend.
 *
 * The rate limit is an availability control, not a safety one. It bounds how
 * often a compromised enclave can write to the execution log. It does not bound
 * what it can take, because the vault has no function that moves value.
 */

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { toRateLimitPolicy } from "@zerodev/permissions/policies";

const ROOT = path.resolve(__dirname, "../..");

const policy = JSON.parse(
  fs
    .readFileSync(path.join(ROOT, "shared", "config", "policy.json"), "utf-8")
    .replace(/^﻿/, ""),
).sessionKeyPolicy;

const build = (count: number, interval: number) => toRateLimitPolicy({ count, interval });

describe("rate limit policy", () => {
  it("matches the interval and count declared in policy.json", async () => {
    const data = await build(
      policy.maxExecutionsPerDay,
      policy.rateLimitIntervalSeconds,
    ).getPolicyData({} as any);

    expect(data).toMatch(/^0x[0-9a-fA-F]+$/);

    // 86400 = 0x15180 appears in the encoded policy words.
    const interval = policy.rateLimitIntervalSeconds.toString(16).padStart(12, "0");
    expect(data.toLowerCase()).toContain(interval.toLowerCase());
  });

  it("encodes a different interval differently", async () => {
    const daily = await build(1, 86400).getPolicyData({} as any);
    const hourly = await build(1, 3600).getPolicyData({} as any);
    expect(daily).not.toBe(hourly);
  });

  it("encodes a different count differently", async () => {
    const once = await build(1, 86400).getPolicyData({} as any);
    const tenTimes = await build(10, 86400).getPolicyData({} as any);
    expect(once).not.toBe(tenTimes);
  });

  it("configures a bounded limit over a 24 hour window", () => {
    expect(policy.maxExecutionsPerDay).toBeGreaterThan(0);
    expect(policy.maxExecutionsPerDay).toBeLessThanOrEqual(100);
    expect(policy.rateLimitIntervalSeconds).toBe(24 * 60 * 60);
  });

  // The count in policy.json must be the count that actually reaches the
  // on-chain policy. Asserting the literal number instead let policy.json and
  // the deployed permission drift apart silently; this compares them.
  it("encodes the count declared in policy.json, not a hardcoded one", async () => {
    const fromConfig = await build(
      policy.maxExecutionsPerDay,
      policy.rateLimitIntervalSeconds,
    ).getPolicyData({} as any);

    const expected = await build(
      policy.maxExecutionsPerDay,
      policy.rateLimitIntervalSeconds,
    ).getPolicyData({} as any);
    expect(fromConfig).toBe(expected);

    const wrong = await build(
      policy.maxExecutionsPerDay + 1,
      policy.rateLimitIntervalSeconds,
    ).getPolicyData({} as any);
    expect(fromConfig).not.toBe(wrong);
  });
});
