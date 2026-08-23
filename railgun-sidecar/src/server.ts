/**
 * Railgun sidecar HTTP API.
 *
 * ISOLATION: this process holds the mnemonic controlling the shielded balance.
 * It binds 0.0.0.0 because Docker's internal networking requires it, but
 * docker-compose places it on an `internal: true` network with no `ports:`
 * mapping, so it is reachable only from sibling containers on that network and
 * never from the host or the internet. scripts/verify_deployment.sh asserts
 * that from outside.
 */

import express from "express";

import { assets, explorerTxUrl, networkConfig } from "./config";
import { poiConfigured, poiNodeUrls, startEngine } from "./engine";
import { createSubmitter } from "./submission";
import { shield } from "./shield";
import { unshieldSwapReshield } from "./swap";
import {
  get0zkAddress,
  getShieldedBalances,
  getSubmitter,
  initWallet,
  scanBalances,
} from "./wallet";

const app = express();
app.use(express.json({ limit: "1mb" }));

let ready = false;
let startupError: string | undefined;

/**
 * Gas the Railgun SDK reserves for a RelayAdapt cross-contract call.
 *
 * Taken from observed `gasEstimateForUnprovenCrossContractCalls` output for
 * an unshield -> Uniswap V3 swap -> reshield recipe. Used only by the
 * read-only preflight below; the real submission always uses the SDK estimate
 * for the actual recipe, never this figure.
 */
const CROSS_CONTRACT_GAS_LIMIT = 3_360_000n;

/**
 * Extra margin the preflight demands on top of the current reservation.
 *
 * The preflight runs at the start of a pipeline run, but the swap is submitted
 * several minutes later — after the SLM, the attestation, a UserOperation, and
 * a Groth16 proof. `maxFeePerGas` is derived from the base fee at each of those
 * moments, so a balance that clears the bar at t=0 can miss it at submission.
 *
 * That is not hypothetical: a run passed this check and then failed at the swap
 * with "insufficient funds for intrinsic transaction cost" after the base fee
 * rose ~8% mid-run, having already spent a UserOperation and a rate-limited
 * session-key slot.
 *
 * 25% covers the base-fee drift observed across a run. It makes the preflight
 * conservative on purpose: a false "insufficient" costs a faucet top-up, while
 * a false "sufficient" costs the very resources this check exists to protect.
 */
const GAS_PREFLIGHT_HEADROOM_PERCENT = 25n;

/** Parse an amount that may arrive as a decimal string, number, or bigint. */
function parseAmount(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`${field} must be an integer in base units, got ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new Error(
    `${field} must be a base-unit integer (e.g. "1000000000000000" for 0.001 WETH), got ${JSON.stringify(value)}`,
  );
}

/**
 * Health, plus the two security-relevant modes stated explicitly.
 *
 * `poi` and `submission` are reported as structured values rather than left for
 * a caller to infer, because both are claims a user interface will repeat. A UI
 * that has to guess whether POI was real, or whether a transaction was private,
 * will eventually guess wrong in the flattering direction.
 */
app.get("/health", (_req, res) => {
  let submission: { mode: string; route: string; mempoolExposed: boolean } | null = null;
  try {
    const route = createSubmitter(getSubmitter());
    submission = { mode: route.mode, route: route.route, mempoolExposed: route.mempoolExposed };
  } catch {
    submission = null;
  }

  const urls = poiNodeUrls();

  res.status(ready ? 200 : 503).json({
    status: ready ? "ok" : "starting",
    service: "aegis-railgun-sidecar",
    engineReady: ready,
    error: startupError,

    poi: {
      // "real" means: a POI aggregator is configured and the engine enforces the
      // required Chainalysis list. There is no bypass mode in this build.
      mode: poiConfigured() ? "real" : "unconfigured",
      configured: poiConfigured(),
      nodeUrls: urls,
      requiredList: "efc6ddb59c098a13fb2b618fdae94c1c3a807abc8fb1837c93620c9143ee9e88",
      note: poiConfigured()
        ? "Spending enforces the required Chainalysis OFAC list via the configured aggregator."
        : "No POI aggregator configured; spending shielded funds is disabled.",
    },

    submission,

    capabilities: {
      shield: ready,
      balances: ready,
      unshieldSwapReshield: ready && poiConfigured(),
    },
  });
});

app.get("/wallet", async (_req, res) => {
  try {
    const submitter = getSubmitter();
    res.json({
      railgunAddress: get0zkAddress(),
      submitterAddress: submitter.address,
      network: networkConfig().network,
      chainId: networkConfig().chainId,
      whitelistedAssets: assets(),
    });
  } catch (error) {
    res.status(503).json({ error: (error as Error).message });
  }
});

/**
 * Can the submitter actually pay for a private swap right now?
 *
 * EIP-1559 requires the sender to hold `gasLimit * maxFeePerGas` up front, not
 * the gas the transaction ends up using. A RelayAdapt cross-contract call is
 * quoted by the Railgun SDK at roughly 3.36M gas (Railgun enforces a minimum so
 * the reshield leg cannot be griefed) while typically consuming ~1.9M, so the
 * reservation is far larger than the eventual cost and is what actually blocks
 * a run.
 *
 * Discovering that at submission time is expensive: by then the pipeline has
 * already spent a UserOperation and consumed a rate-limited session-key slot,
 * and the Groth16 proof took minutes to build. This endpoint is read-only and
 * lets a caller find out first.
 *
 * The gas figure is a representative reservation, not a quote for one specific
 * swap — the real estimate needs the recipe, which needs the amounts. It is
 * deliberately the SDK's own upper bound, so a pass here means the real
 * submission will not fail on funds.
 */
app.get("/gas-preflight", async (_req, res) => {
  try {
    const submitter = getSubmitter();
    const provider = submitter.provider!;
    const [balance, feeData] = await Promise.all([
      provider.getBalance(submitter.address),
      provider.getFeeData(),
    ]);

    // Mirrors swap.ts originalGasDetails exactly, including its fallbacks.
    const maxFeePerGas = feeData.maxFeePerGas ?? 2_000_000_000n;
    const reserve = CROSS_CONTRACT_GAS_LIMIT * maxFeePerGas;
    const required = (reserve * (100n + GAS_PREFLIGHT_HEADROOM_PERCENT)) / 100n;
    const sufficient = balance >= required;

    res.json({
      submitterAddress: submitter.address,
      balanceWei: balance.toString(),
      baseFeePerGasWei: (feeData.gasPrice ?? 0n).toString(),
      maxFeePerGasWei: maxFeePerGas.toString(),
      gasLimit: CROSS_CONTRACT_GAS_LIMIT.toString(),
      reserveAtCurrentFeeWei: reserve.toString(),
      headroomPercent: Number(GAS_PREFLIGHT_HEADROOM_PERCENT),
      requiredReserveWei: required.toString(),
      sufficient,
      shortfallWei: sufficient ? "0" : (required - balance).toString(),
    });
  } catch (error) {
    res.status(503).json({ error: (error as Error).message });
  }
});

app.get("/balances", async (_req, res) => {
  try {
    await scanBalances();
    res.json({ balances: await getShieldedBalances(), railgunAddress: get0zkAddress() });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post("/shield", async (req, res) => {
  try {
    const { token, amount } = req.body ?? {};
    if (!token) return res.status(400).json({ error: "body must include { token, amount }" });

    const result = await shield(String(token), parseAmount(amount, "amount"));
    await scanBalances();

    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

app.post("/unshield-swap-reshield", async (req, res) => {
  try {
    const { sellToken, buyToken, sellAmount, slippageBps, feeTier } = req.body ?? {};

    if (!sellToken || !buyToken) {
      return res.status(400).json({
        error: "body must include { sellToken, buyToken, sellAmount }",
      });
    }

    const result = await unshieldSwapReshield({
      sellToken: String(sellToken),
      buyToken: String(buyToken),
      sellAmount: parseAmount(sellAmount, "sellAmount"),
      slippageBps: slippageBps === undefined ? undefined : Number(slippageBps),
      feeTier: feeTier === undefined ? undefined : Number(feeTier),
    });

    await scanBalances();
    res.json({ success: true, ...result });
  } catch (error) {
    const message = (error as Error).message;
    // 501 when the capability is configured off, rather than 500: this is a
    // deployment gap, not a runtime fault, and the orchestrator reports it
    // differently.
    const status = message.includes("RAILGUN_POI_NODE_URL") ? 501 : 500;
    res.status(status).json({ success: false, error: message });
  }
});

const PORT = Number(process.env.PORT ?? 8080);

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`[railgun] sidecar listening on 0.0.0.0:${PORT}`);
  try {
    await startEngine();
    const wallet = await initWallet();
    await scanBalances();
    ready = true;
    console.log(`[railgun] ready — 0zk ${wallet.railgunAddress}`);
    console.log(`[railgun] explorer base: ${explorerTxUrl("<txHash>")}`);
  } catch (error) {
    // Recorded and surfaced through /health rather than swallowed. The previous
    // version logged the failure and then served mocked responses as if the
    // engine had started.
    startupError = (error as Error).message;
    console.error("[railgun] STARTUP FAILED:", startupError);
  }
});
