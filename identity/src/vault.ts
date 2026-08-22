/**
 * Typed access to AegisVault and AttestationVerifier.
 *
 * ABIs come from shared/abi/, which is regenerated from the Foundry build
 * output. Nothing here hand-writes a fragment — a hand-written ABI that drifts
 * from the deployed bytecode produces decode failures that look like network
 * errors.
 */

import * as fs from "fs";
import * as path from "path";
import { Abi, Address, Hex, decodeEventLog, encodeFunctionData } from "viem";

import { REPO_ROOT, deployedConfig, requireAddress } from "./config";
import { getPublicClient } from "./clients";

function loadAbi(name: string): Abi {
  const abiPath = path.join(REPO_ROOT, "shared", "abi", `${name}.json`);
  if (!fs.existsSync(abiPath)) {
    throw new Error(
      `ABI not found at ${abiPath}. Run 'forge build' in contracts/ and ` +
        `scripts/sync_abi.py to regenerate it.`,
    );
  }
  const raw = fs.readFileSync(abiPath, "utf-8").replace(/^﻿/, "");
  const abi = JSON.parse(raw) as Abi;
  if (!Array.isArray(abi) || abi.length === 0) {
    throw new Error(`ABI at ${abiPath} is empty; regenerate it from the Foundry build.`);
  }
  return abi;
}

export const VAULT_ABI = loadAbi("AegisVault");
export const VERIFIER_ABI = loadAbi("AttestationVerifier");

export function vaultAddress(): Address {
  return requireAddress(deployedConfig().AegisVault, "deployed.json AegisVault");
}

export function verifierAddress(): Address {
  return requireAddress(deployedConfig().AttestationVerifier, "deployed.json AttestationVerifier");
}

/** Calldata for `AegisVault.rebalance(bytes32,bytes)`. */
export function encodeRebalance(decisionHash: Hex, attestationProof: Hex): Hex {
  return encodeFunctionData({
    abi: VAULT_ABI,
    functionName: "rebalance",
    args: [decisionHash, attestationProof],
  });
}

export interface VaultState {
  address: Address;
  owner: Address;
  attestationVerifier: Address;
  sessionKey: Address;
  sessionKeySet: boolean;
  rebalanceCount: bigint;
  lastRebalanceAt: bigint;
  whitelistedAssets: Address[];
}

export async function readVaultState(): Promise<VaultState> {
  const client = await getPublicClient();
  const address = vaultAddress();
  const read = <T>(functionName: string, args: unknown[] = []) =>
    client.readContract({ address, abi: VAULT_ABI, functionName, args }) as Promise<T>;

  const [owner, attestationVerifier, sessionKey, sessionKeySet, rebalanceCount, lastRebalanceAt, assets] =
    await Promise.all([
      read<Address>("owner"),
      read<Address>("attestationVerifier"),
      read<Address>("sessionKey"),
      read<boolean>("sessionKeySet"),
      read<bigint>("rebalanceCount"),
      read<bigint>("lastRebalanceAt"),
      read<Address[]>("whitelistedAssets"),
    ]);

  return {
    address,
    owner,
    attestationVerifier,
    sessionKey,
    sessionKeySet,
    rebalanceCount,
    lastRebalanceAt,
    whitelistedAssets: [...assets],
  };
}

export interface VerifierState {
  address: Address;
  owner: Address;
  oracleSigner: Address;
  expectedMeasurement: Hex;
}

export async function readVerifierState(): Promise<VerifierState> {
  const client = await getPublicClient();
  const address = verifierAddress();
  const read = <T>(functionName: string) =>
    client.readContract({ address, abi: VERIFIER_ABI, functionName }) as Promise<T>;

  const [owner, oracleSigner, expectedMeasurement] = await Promise.all([
    read<Address>("owner"),
    read<Address>("oracleSigner"),
    read<Hex>("expectedMeasurement"),
  ]);

  return { address, owner, oracleSigner, expectedMeasurement };
}

/** Whether a decision hash has already been recorded (the on-chain replay guard). */
export async function isDecisionExecuted(decisionHash: Hex): Promise<boolean> {
  const client = await getPublicClient();
  return client.readContract({
    address: vaultAddress(),
    abi: VAULT_ABI,
    functionName: "isDecisionExecuted",
    args: [decisionHash],
  }) as Promise<boolean>;
}

export interface RebalanceEvent {
  decisionHash: Hex;
  timestamp: bigint;
  sequence: bigint;
}

/**
 * Pull RebalanceExecuted out of a transaction receipt.
 *
 * Deliberately reads the receipt rather than querying by block range: the free
 * Alchemy tier caps eth_getLogs at a 10-block window, so a range query is the
 * wrong tool for confirming a transaction you just sent. Logs from other
 * contracts in the same receipt are skipped rather than treated as errors.
 */
export function extractRebalanceEvents(logs: readonly any[]): RebalanceEvent[] {
  const vault = vaultAddress().toLowerCase();
  const events: RebalanceEvent[] = [];

  for (const log of logs) {
    if (String(log.address).toLowerCase() !== vault) continue;
    try {
      const decoded = decodeEventLog({ abi: VAULT_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "RebalanceExecuted") {
        const args = decoded.args as unknown as RebalanceEvent;
        events.push({
          decisionHash: args.decisionHash,
          timestamp: args.timestamp,
          sequence: args.sequence,
        });
      }
    } catch {
      // A log from the vault that is not one of our events (or a future event
      // this ABI predates) is not a failure.
    }
  }

  return events;
}
