/**
 * Railgun engine lifecycle.
 *
 * The previous implementation called `startRailgunEngine(dbPath, dbPath, ...)`
 * with a *string* where the engine expects an AbstractLevelDOWN instance, and
 * `undefined` for the required artifact store. It threw on every startup; the
 * error was caught and logged, and the service carried on serving mocked
 * responses. Everything here is the real initialisation, verified against a
 * live Sepolia node.
 *
 * Four things must be set up, in order:
 *   1. A LevelDB instance for merkletree and wallet state.
 *   2. An artifact store, so Groth16 circuit artifacts are cached on disk.
 *   3. The snarkjs prover implementation.
 *   4. A fallback provider whose weights satisfy the engine's quorum rule.
 */

import * as fs from "fs";
import * as path from "path";
import LevelDOWN from "leveldown";
import * as snarkjs from "snarkjs";
import {
  ArtifactStore,
  getProver,
  loadProvider,
  setLoggers,
  startRailgunEngine,
  stopRailgunEngine,
} from "@railgun-community/wallet";
import {
  FallbackProviderJsonConfig,
  FeesSerialized,
  NetworkName,
} from "@railgun-community/shared-models";
import { setRailgunFees } from "@railgun-community/cookbook";

import { enginePaths, networkConfig, redact, rpcUrls } from "./config";

/**
 * Railgun network identity, resolved from `network.json` rather than compiled in.
 *
 * This used to be `NetworkName.EthereumSepolia` and `{ type: 0, id: 11155111 }`
 * as literals in three separate files. That made the chain a property of the
 * build instead of the deployment: pointing the stack at mainnet meant editing
 * source, which is exactly the kind of change nobody wants to make under
 * pressure. Resolving it here means one config file decides, and a mismatch is
 * impossible because every module reads the same export.
 *
 * Only chains Railgun actually supports can be named — an unsupported chainId
 * fails loudly at startup rather than producing a wallet on the wrong network.
 */
const RAILGUN_NETWORKS: Record<number, NetworkName> = {
  1: NetworkName.Ethereum,
  11155111: NetworkName.EthereumSepolia,
  137: NetworkName.Polygon,
  42161: NetworkName.Arbitrum,
  56: NetworkName.BNBChain,
};

function resolveNetwork(): { name: NetworkName; chainId: number } {
  const { chainId, network } = networkConfig();
  const name = RAILGUN_NETWORKS[chainId];

  if (!name) {
    throw new Error(
      `network.json names chainId ${chainId} ("${network}"), which Railgun does not ` +
        `support in this build. Supported: ${Object.keys(RAILGUN_NETWORKS).join(", ")}. ` +
        `Refusing to start rather than operate a shielded wallet on the wrong chain.`,
    );
  }

  return { name, chainId };
}

const resolved = resolveNetwork();

export const NETWORK_NAME: NetworkName = resolved.name;
export const CHAIN = { type: 0, id: resolved.chainId } as const;

/** True when the configured chain is a network with a real MEV builder market. */
export const HAS_BUILDER_MARKET = resolved.chainId === 1;

let started = false;
let unshieldFeeBasisPoints: bigint | undefined;
let shieldFeeBasisPoints: bigint | undefined;

/**
 * On-disk artifact store.
 *
 * Groth16 artifacts (wasm + zkey) are tens of megabytes and are fetched on
 * first use. Caching them on a mounted volume means one download for the life
 * of the deployment instead of one per container restart — which matters
 * because proof generation is already the slowest step in the pipeline.
 */
function createArtifactStore(artifactRoot: string): ArtifactStore {
  fs.mkdirSync(artifactRoot, { recursive: true });

  return new ArtifactStore(
    async (filePath: string) => {
      const full = path.join(artifactRoot, filePath);
      return fs.existsSync(full) ? fs.readFileSync(full) : null;
    },
    async (dir: string, filePath: string, item: string | Uint8Array) => {
      fs.mkdirSync(path.join(artifactRoot, dir), { recursive: true });
      fs.writeFileSync(path.join(artifactRoot, filePath), item);
    },
    async (filePath: string) => fs.existsSync(path.join(artifactRoot, filePath)),
  );
}

/**
 * Fallback provider config.
 *
 * Two constraints the engine imposes that are easy to get wrong:
 *
 *   - Total weight across providers must be >= 2, or `loadProvider` throws
 *     "Invalid fallback provider config". A single provider with weight 1 —
 *     which is what the previous code used — always fails this.
 *
 *   - `maxLogsPerBatch` must respect the endpoint's eth_getLogs range cap.
 *     Alchemy's free tier rejects ranges wider than 10 blocks, so it is capped
 *     at 10 here while more permissive public endpoints get a larger batch.
 *     The bulk of the historical sync comes from the Railgun squid subgraph
 *     rather than from RPC log queries, so the small batch size is not the
 *     bottleneck it looks like.
 */
function buildProviderConfig(): FallbackProviderJsonConfig {
  const net = networkConfig();
  const urls = rpcUrls();

  if (urls.length === 0) {
    throw new Error("No RPC URLs configured; set ALCHEMY_API_KEY or AEGIS_RPC_URL.");
  }

  const providers = urls.slice(0, 3).map((url, index) => ({
    provider: url,
    priority: index + 1,
    // Give the primary weight 2 so quorum is satisfied even when it is the
    // only endpoint configured.
    weight: index === 0 ? 2 : 1,
    stallTimeout: 15_000,
    maxLogsPerBatch: url.includes("alchemy.com") ? 10 : 500,
  }));

  return { chainId: net.chainId, providers };
}

/**
 * Hand Cookbook the live shield/unshield fees.
 *
 * `RailgunConfig.{SHIELD,UNSHIELD}_FEE_BASIS_POINTS_FOR_NETWORK` are empty maps
 * that the caller is expected to fill; Cookbook ships no Sepolia entry, so
 * without this every recipe fails at the unshield step with "No unshield fee
 * defined for network Ethereum_Sepolia".
 *
 * The values come from `loadProvider`, which reads them off the deployed
 * Railgun contracts. Hardcoding the usual 25 basis points would work today and
 * silently mis-price every recipe the moment the protocol changed its fee — and
 * the symptom would be a recipe whose expected output no longer matches what
 * the chain produces.
 */
function configureCookbookFees(fees: FeesSerialized): void {
  // Serialized as hex strings, with or without a 0x prefix depending on the
  // engine version.
  const shield = BigInt("0x" + fees.shieldFeeV2.replace(/^0x/, ""));
  const unshield = BigInt("0x" + fees.unshieldFeeV2.replace(/^0x/, ""));

  setRailgunFees(NETWORK_NAME, shield, unshield);
  shieldFeeBasisPoints = shield;
  unshieldFeeBasisPoints = unshield;

  console.log(
    `[railgun] fees from chain: shield ${shield} bps, unshield ${unshield} bps`,
  );
}

export interface EngineStartOptions {
  /** Skip the historical scan. Only valid when no wallet will be loaded. */
  skipMerkletreeScans?: boolean;
}

export async function startEngine(options: EngineStartOptions = {}): Promise<void> {
  if (started) return;

  const paths = enginePaths();
  fs.mkdirSync(paths.base, { recursive: true });

  setLoggers(
    (message: string) => {
      if (process.env.RAILGUN_VERBOSE === "true") console.log("[railgun]", message);
    },
    (error: string) => console.error("[railgun]", String(error).slice(0, 300)),
  );

  /**
   * POI (Proof of Innocence) node URLs.
   *
   * Sepolia is configured as a POI-required network, so `loadProvider` refuses
   * to run unless POI has been initialised. Initialisation itself performs no
   * network I/O — it only registers the node interface — which is why shielding
   * and balance scanning work against an unreachable POI node.
   *
   * Spending shielded funds is different: generating a transact proof requires
   * POI merkle proofs from a live aggregator. Without a reachable node,
   * unshield and cross-contract calls fail. See RAILGUN_POI_NODE_URL in
   * .env.example and the "Proof of Innocence" section of the sidecar README.
   */
  const poiNodeURLs = (process.env.RAILGUN_POI_NODE_URL ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

  await startRailgunEngine(
    "aegis",
    new (LevelDOWN as any)(paths.db),
    process.env.RAILGUN_VERBOSE === "true",
    createArtifactStore(paths.artifacts),
    false, // useNativeArtifacts: the native prover is not bundled in this image
    options.skipMerkletreeScans ?? false,
    poiNodeURLs.length > 0 ? poiNodeURLs : ["https://poi-node-unset.invalid"],
  );

  // snarkjs supplies the Groth16 implementation. Without this the engine can
  // build transactions but cannot prove them, and the failure appears only at
  // proof time.
  getProver().setSnarkJSGroth16(snarkjs.groth16 as any);

  const providerConfig = buildProviderConfig();
  console.log(
    "[railgun] loading provider:",
    providerConfig.providers.map((p) => redact(p.provider)).join(", "),
  );

  const { feesSerialized } = await loadProvider(providerConfig, NETWORK_NAME, 10_000);

  configureCookbookFees(feesSerialized);

  started = true;
  console.log("[railgun] engine ready");
  if (poiNodeURLs.length === 0) {
    console.warn(
      "[railgun] RAILGUN_POI_NODE_URL is unset. Shielding and balance scans work; " +
        "unshield and unshield-swap-reshield will fail at proof generation.",
    );
  }
}

/**
 * The unshield fee, in basis points, as read from the chain at startup.
 *
 * Needed by the swap layer: Railgun deducts this fee during the unshield step,
 * *before* any internal recipe step runs. Quoting the full requested amount
 * would price a swap larger than the one that can actually execute, and the
 * recipe then fails with "Specified amount exceeds balance".
 */
export function getUnshieldFeeBasisPoints(): bigint {
  if (unshieldFeeBasisPoints === undefined) {
    throw new Error("Railgun fees are not loaded; startEngine() must run first.");
  }
  return unshieldFeeBasisPoints;
}

export function getShieldFeeBasisPoints(): bigint {
  if (shieldFeeBasisPoints === undefined) {
    throw new Error("Railgun fees are not loaded; startEngine() must run first.");
  }
  return shieldFeeBasisPoints;
}

export function isEngineStarted(): boolean {
  return started;
}

export function poiConfigured(): boolean {
  return poiNodeUrls().length > 0;
}

/** Configured POI aggregator URLs, in priority order. */
export function poiNodeUrls(): string[] {
  return (process.env.RAILGUN_POI_NODE_URL ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
}

export async function stopEngine(): Promise<void> {
  if (!started) return;
  await stopRailgunEngine();
  started = false;
}
