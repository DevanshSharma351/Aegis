/**
 * Sidecar configuration.
 *
 * Reads the same shared/config files as every other workstream, so the asset
 * whitelist and the Railgun/Uniswap addresses have exactly one definition.
 */

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

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
    `Could not locate the repository root above ${__dirname}. Set AEGIS_REPO_ROOT.`,
  );
}

export const REPO_ROOT = findRepoRoot();
// `quiet: true` suppresses the dotenv v17 banner, which is printed to STDOUT.
// printState.ts and the pipeline parse this process's stdout as JSON, and the
// banner makes JSON.parse fail with an error that points nowhere near the cause.
dotenv.config({ path: path.join(REPO_ROOT, ".env"), quiet: true });

function readJson<T>(file: string): T {
  const full = path.join(REPO_ROOT, "shared", "config", file);
  if (!fs.existsSync(full)) throw new Error(`Missing shared config: ${full}`);
  return JSON.parse(fs.readFileSync(full, "utf-8").replace(/^﻿/, "")) as T;
}

export interface AssetConfig {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  coingeckoId: string;
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
  railgun: {
    proxyContract: string;
    relayAdaptContract: string;
    deploymentBlock: number;
  };
  uniswapV3: {
    swapRouter02: string;
    quoterV2: string;
    factory: string;
    defaultFeeTier: number;
  };
}

export const networkConfig = (): NetworkConfig => readJson<NetworkConfig>("network.json");
export const assets = (): AssetConfig[] => readJson<{ assets: AssetConfig[] }>("assets.json").assets;

export function assetBySymbol(symbol: string): AssetConfig {
  const found = assets().find((a) => a.symbol.toUpperCase() === symbol.toUpperCase());
  if (!found) {
    throw new Error(
      `${symbol} is not in the asset whitelist. Allowed: ${assets().map((a) => a.symbol).join(", ")}`,
    );
  }
  return found;
}

/**
 * Resolve a token reference that may be a symbol or an address.
 *
 * Always resolves through the whitelist, never by trusting a caller-supplied
 * address directly. The previous pipeline sent the literal strings "0xWETH" and
 * "0xUSDC" to this service; resolving through the whitelist turns that class of
 * mistake into an immediate, named error instead of a malformed transaction.
 */
export function resolveAsset(reference: string): AssetConfig {
  const trimmed = reference.trim();

  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    const found = assets().find((a) => a.address.toLowerCase() === trimmed.toLowerCase());
    if (!found) {
      throw new Error(
        `Address ${trimmed} is not in the asset whitelist. The sidecar only ` +
          `handles whitelisted assets.`,
      );
    }
    return found;
  }

  return assetBySymbol(trimmed);
}

export function requireEnv(name: string, why: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name} — ${why}`);
  return value;
}

/** RPC endpoints in priority order. */
export function rpcUrls(): string[] {
  const net = networkConfig();
  const urls: string[] = [];

  const explicit = process.env[net.rpc.primaryEnvVar]?.trim();
  if (explicit) urls.push(explicit);

  const alchemyKey = process.env[net.rpc.alchemyKeyEnvVar]?.trim();
  if (alchemyKey) urls.push(net.rpc.alchemyUrlTemplate.replace("{key}", alchemyKey));

  urls.push(...net.rpc.fallbackUrls);
  return [...new Set(urls)];
}

export function redact(url: string): string {
  return url.replace(/(\/v2\/|apikey=|api_key=)[^/&?]+/gi, "$1***");
}

export const enginePaths = () => {
  const base = process.env.RAILGUN_ENGINE_DB_PATH?.trim() || path.join(REPO_ROOT, ".railgun");
  return {
    base,
    db: path.join(base, "engine.db"),
    artifacts: path.join(base, "artifacts"),
  };
};

export function explorerTxUrl(txHash: string): string {
  return `${networkConfig().blockExplorer}/tx/${txHash}`;
}
