/**
 * Identity service HTTP API.
 *
 * Exists so the orchestrator can drive submission over the internal network
 * instead of shelling out to `npm run` with secrets passed as environment
 * variables on a command line — which is what the previous pipeline did, and
 * which put the session key in the process table of every process on the host.
 *
 * Reachable only from the internal Docker network. It holds the session key.
 */

import express from "express";

import { deployedConfig, explorerTxUrl, networkConfig } from "./config";
import { getPublicClient } from "./clients";
import { loadSessionKeyAccount } from "./sessionKey";
import { submitRebalance } from "./submitUserOp";
import { readVaultState, readVerifierState } from "./vault";

const app = express();
app.use(express.json({ limit: "1mb" }));

/** BigInt is not JSON-serialisable; render as decimal strings. */
function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
}

/**
 * Liveness.
 *
 * Deliberately does NOT require the session-key approval to exist. The approval
 * is produced by a one-time bootstrap that runs after the container is already
 * up, so failing the healthcheck on its absence would make
 * `docker compose up --wait` impossible to satisfy before bootstrapping — a
 * deadlock, since the bootstrap needs the stack running.
 *
 * Readiness is reported as a field instead, and /submit-rebalance enforces it
 * properly at the point where it actually matters.
 */
app.get("/health", async (_req, res) => {
  try {
    const client = await getPublicClient();
    const [chainId, blockNumber] = await Promise.all([
      client.getChainId(),
      client.getBlockNumber(),
    ]);

    let smartAccount: string | null = null;
    let sessionKeyReady = false;
    let notReadyReason: string | undefined;

    try {
      smartAccount = (await loadSessionKeyAccount()).account.address;
      sessionKeyReady = true;
    } catch (error) {
      notReadyReason = (error as Error).message;
    }

    res.json({
      status: "ok",
      service: "aegis-identity",
      chainId,
      blockNumber: blockNumber.toString(),
      smartAccount,
      sessionKeyReady,
      notReadyReason,
    });
  } catch (error) {
    // The RPC being unreachable IS a real failure: without it the service can
    // do nothing at all.
    res.status(503).json({ status: "degraded", error: (error as Error).message });
  }
});

/** Full on-chain view of the deployment. Backs scripts/verify_deployment.sh. */
app.get("/state", async (_req, res) => {
  try {
    const [vault, verifier, { account }] = await Promise.all([
      readVaultState(),
      readVerifierState(),
      loadSessionKeyAccount(),
    ]);

    res.json(
      jsonSafe({
        network: networkConfig().network,
        chainId: networkConfig().chainId,
        deployed: deployedConfig(),
        smartAccount: account.address,
        vault,
        verifier,
        sessionKeyBoundCorrectly:
          vault.sessionKeySet &&
          vault.sessionKey.toLowerCase() === account.address.toLowerCase(),
      }),
    );
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post("/submit-rebalance", async (req, res) => {
  const { decisionHash, attestationProof } = req.body ?? {};

  if (typeof decisionHash !== "string" || typeof attestationProof !== "string") {
    return res.status(400).json({
      error: "body must be { decisionHash: string, attestationProof: string }",
    });
  }

  try {
    const result = await submitRebalance(decisionHash, attestationProof);
    res.json({ success: true, ...result });
  } catch (error) {
    const message = (error as Error).message;
    // 409 for "this decision is already recorded" — a distinct, expected
    // outcome that the orchestrator reports rather than retries.
    const status = message.includes("already been executed") ? 409 : 500;
    res.status(status).json({ success: false, error: message });
  }
});

const PORT = Number(process.env.IDENTITY_PORT ?? 8200);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[identity] listening on 0.0.0.0:${PORT}`);
  console.log(`[identity] explorer base: ${explorerTxUrl("<txHash>")}`);
});
