/**
 * Shared configuration for the identity service.
 *
 * Every path, address, and endpoint the service needs is resolved here, once.
 * The previous code resolved `shared/config/deployed.json` as
 * `path.resolve(__dirname, "../../../shared/...")` — three levels up from
 * `identity/src` lands *outside* the repository, so the lookup only ever
 * succeeded by accident of the container layout. Centralising it means one
 * place to be wrong, and one place that reports a useful error when it is.
 */

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { Address, Chain, Hex, defineChain, isAddress } from "viem";
import { sepolia } from "viem/chains";

// ---------------------------------------------------------------------------
// Repository layout
// ---------------------------------------------------------------------------

/**
 * Locate the repo root by walking up until `shared/config` appears.
 *
 * Works from `identity/src` (tsx), `identity/dist` (compiled), and `/app`
 * (container, where shared/ is mounted alongside), without any of them needing
 * to agree on a relative depth.
 */
function findRepoRoot(): string {
  const override = process.env.AEGIS_REPO_ROOT;
  if (override) return override;

  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "shared", "config"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `Could not locate the repository root (no shared/config found above ${__dirname}). ` +
      `Set AEGIS_REPO_ROOT to point at it.`,
  );
}

export const REPO_ROOT = findRepoRoot();
export const SHARED_CONFIG_DIR = path.join(REPO_ROOT, "shared", "config");
export const DEPLOYED_PATH = path.join(SHARED_CONFIG_DIR, "deployed.json");
export const POLICY_PATH = path.join(SHARED_CONFIG_DIR, "policy.json");
export const ASSETS_PATH = path.join(SHARED_CONFIG_DIR, "assets.json");
export const NETWORK_PATH = path.join(SHARED_CONFIG_DIR, "network.json");
/** Session-key approval blob. Contains an enable signature, not a private key. */
export const APPROVAL_PATH = path.join(SHARED_CONFIG_DIR, "session-key-approval.json");

// `quiet: true` suppresses the dotenv v17 banner, which is printed to STDOUT.
// printState.ts and the pipeline parse this process's stdout as JSON, and the
// banner makes JSON.parse fail with an error that points nowhere near the cause.
dotenv.config({ path: path.join(REPO_ROOT, ".env"), quiet: true });

// ---------------------------------------------------------------------------
// Config files
// ---------------------------------------------------------------------------

function readJson<T>(filePath: string, hint: string): T {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${path.basename(filePath)} not found at ${filePath}. ${hint}`);
  }
  // Strip a UTF-8 BOM if present: files touched by PowerShell redirection pick
  // one up, and JSON.parse rejects it with a uselessly opaque message.
  const raw = fs.readFileSync(filePath, "utf-8").replace(/^﻿/, "");
  return JSON.parse(raw) as T;
}

export interface NetworkConfig {
  network: string;
  chainId: number;
  blockExplorer: string;
  rpc: {
    primaryEnvVar: string;
    alchemyKeyEnvVar: string;
    alchemyUrlTemplate: string;
    fallbackUrls: string[];
  };
  bundler: { apiKeyEnvVar: string; urlTemplate: string };
}

export interface DeployedConfig {
  chainId?: number;
  AegisVault?: Address;
  AttestationVerifier?: Address;
  oracleSigner?: Address;
  sessionKey?: Address;
  expectedMeasurement?: Hex;
  attestationSource?: string;
  deployedAtBlock?: number;
  smartAccount?: Address;
}

export interface PolicyConfig {
  sessionKeyPolicy: {
    maxExecutionsPerDay: number;
    rateLimitIntervalSeconds: number;
    valueLimitWei: string;
    callPolicyVersion: string;
    allowedSelectors: { selector: Hex; signature: string; target: string }[];
  };
}

export const networkConfig = (): NetworkConfig =>
  readJson<NetworkConfig>(NETWORK_PATH, "It ships with the repo; check your checkout.");

export const policyConfig = (): PolicyConfig =>
  readJson<PolicyConfig>(POLICY_PATH, "It ships with the repo; check your checkout.");

export const deployedConfig = (): DeployedConfig =>
  readJson<DeployedConfig>(
    DEPLOYED_PATH,
    "Deploy the contracts first: scripts/deploy_sepolia.sh",
  );

/** Merge a partial update into deployed.json, preserving unrelated keys. */
export function updateDeployedConfig(patch: Partial<DeployedConfig>): DeployedConfig {
  const current = fs.existsSync(DEPLOYED_PATH) ? deployedConfig() : {};
  const merged = { ...current, ...patch };
  fs.writeFileSync(DEPLOYED_PATH, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  return merged;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export function requireEnv(name: string, why: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name} — ${why}`);
  return value;
}

/** Normalise a private key that may or may not carry the 0x prefix. */
export function requirePrivateKey(name: string, why: string): Hex {
  const value = requireEnv(name, why);
  const hex = (value.startsWith("0x") ? value : `0x${value}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    // Never echo the value: this function only ever handles secrets.
    throw new Error(`${name} is not a 32-byte hex private key (got ${hex.length - 2} hex chars)`);
  }
  return hex;
}

export function requireAddress(value: string | undefined, name: string): Address {
  if (!value || !isAddress(value)) {
    throw new Error(`${name} is not a valid address: ${value ?? "<unset>"}`);
  }
  return value as Address;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * RPC endpoints in priority order.
 *
 * Returns a list rather than a single URL so the caller can fail over. Sepolia
 * public endpoints are unreliable enough that a single hard-coded URL turns a
 * transient upstream problem into a failed rebalance.
 */
export function rpcUrls(): string[] {
  const net = networkConfig();
  const urls: string[] = [];

  const explicit = process.env[net.rpc.primaryEnvVar]?.trim();
  if (explicit) urls.push(explicit);

  const alchemyKey = process.env[net.rpc.alchemyKeyEnvVar]?.trim();
  if (alchemyKey) urls.push(net.rpc.alchemyUrlTemplate.replace("{key}", alchemyKey));

  urls.push(...net.rpc.fallbackUrls);
  return urls;
}

/**
 * Pimlico bundler URL.
 *
 * Note this is a bundler, not a general JSON-RPC node: it answers
 * eth_sendUserOperation and friends, not eth_call. Pointing a normal wallet
 * client at it produces confusing failures, so nothing else in the repo should
 * use this value as an RPC endpoint.
 */
export function bundlerUrl(): string {
  const net = networkConfig();
  const key = requireEnv(
    net.bundler.apiKeyEnvVar,
    "the ERC-4337 bundler and paymaster are reached through Pimlico",
  );
  // {chainId} comes from the same file as the chain everything else uses, so
  // the bundler can never be pointed at a different network than the account.
  // The chain id used to be baked into this URL as a literal, which meant a
  // network switch silently kept submitting to the old chain's bundler.
  return net.bundler.urlTemplate
    .replace("{chainId}", String(net.chainId))
    .replace("{key}", key);
}

export function chain(): Chain {
  const net = networkConfig();
  if (net.chainId === sepolia.id) return sepolia;

  // Supports pointing the stack at an Anvil fork without editing viem chains.
  return defineChain({
    id: net.chainId,
    name: net.network,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: rpcUrls() } },
  });
}

export function explorerTxUrl(txHash: string): string {
  return `${networkConfig().blockExplorer}/tx/${txHash}`;
}
