#!/usr/bin/env python3
"""
Generate frontend/lib/generated/deployment.ts from shared/.

The frontend is a separate Next.js app and cannot reliably import JSON from
outside its own root, so the deployment facts are snapshotted into a typed
module instead. Running this as a `predev`/`prebuild` step keeps shared/ as the
single source of truth while letting the frontend build standalone — including
on a host that has never seen the backend repo.

Re-run after any deploy or contract change:

    python scripts/sync_frontend_config.py
"""

from __future__ import annotations

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHARED = ROOT / "shared"
OUT = ROOT / "frontend" / "lib" / "generated" / "deployment.ts"


def load(path: pathlib.Path):
    if not path.exists():
        print(f"missing: {path}", file=sys.stderr)
        raise SystemExit(1)
    return json.loads(path.read_text(encoding="utf-8-sig"))


def main() -> int:
    deployed = load(SHARED / "config" / "deployed.json")
    assets = load(SHARED / "config" / "assets.json")["assets"]
    policy = load(SHARED / "config" / "policy.json")["sessionKeyPolicy"]
    network = load(SHARED / "config" / "network.json")
    vault_abi = load(SHARED / "abi" / "AegisVault.json")
    verifier_abi = load(SHARED / "abi" / "AttestationVerifier.json")

    for required in ("AegisVault", "AttestationVerifier", "expectedMeasurement"):
        if not deployed.get(required):
            print(f"deployed.json is missing {required}; deploy first.", file=sys.stderr)
            return 1

    def ts(value) -> str:
        return json.dumps(value, indent=2)

    body = f'''/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Written by scripts/sync_frontend_config.py from shared/config and shared/abi.
 * Re-run that script after any deployment or contract change.
 *
 * Snapshotting rather than importing across the repo boundary keeps shared/ as
 * the single source of truth while letting the frontend build on its own.
 */

export const CHAIN_ID = {deployed.get("chainId", 11155111)} as const;
export const BLOCK_EXPLORER = {json.dumps(network["blockExplorer"])} as const;

/**
 * Block the contracts were deployed in. Bounds every log query.
 *
 * `BigInt("...")` rather than a `123n` literal: the literal form requires a
 * compile target of ES2020+, and this file is consumed by a Next.js app whose
 * tsconfig is not ours to depend on.
 */
export const DEPLOYED_AT_BLOCK = BigInt("{deployed.get("deployedAtBlock", 0)}");

export const ADDRESSES = {{
  aegisVault: {json.dumps(deployed["AegisVault"])},
  attestationVerifier: {json.dumps(deployed["AttestationVerifier"])},
  oracleSigner: {json.dumps(deployed.get("oracleSigner", ""))},
  smartAccount: {json.dumps(deployed.get("smartAccount", ""))},
  sessionKey: {json.dumps(deployed.get("sessionKey", ""))},
}} as const;

/**
 * The enclave measurement this deployment was built against.
 *
 * Compared client-side against AttestationVerifier.expectedMeasurement() read
 * live from chain. A mismatch means the enclave was rebuilt without rotating the
 * on-chain constant, and the UI says so rather than showing a green tick.
 */
export const EXPECTED_MEASUREMENT = {json.dumps(deployed["expectedMeasurement"])} as const;

/**
 * Whether the recorded attestation came from real TDX hardware or the dstack
 * simulator. Surfaced verbatim in the UI: a simulator quote exercises every code
 * path but proves nothing about hardware, and presenting it as hardware
 * attestation would be a lie.
 */
export const ATTESTATION_SOURCE = {json.dumps(deployed.get("attestationSource", "unknown"))} as const;

export const ASSETS = {ts([
        {"symbol": a["symbol"], "name": a["name"], "address": a["address"], "decimals": a["decimals"]}
        for a in assets
    ])} as const;

export const SESSION_KEY_POLICY = {ts({
        "maxExecutionsPerDay": policy["maxExecutionsPerDay"],
        "rateLimitIntervalSeconds": policy["rateLimitIntervalSeconds"],
        "valueLimitWei": policy["valueLimitWei"],
        "withdrawalPermissions": policy["withdrawalPermissions"],
        "allowedSelectors": policy["allowedSelectors"],
    })} as const;

export const AEGIS_VAULT_ABI = {ts(vault_abi)} as const;

export const ATTESTATION_VERIFIER_ABI = {ts(verifier_abi)} as const;
'''

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(body, encoding="utf-8")

    print(f"wrote {OUT.relative_to(ROOT)}")
    print(f"  vault       {deployed['AegisVault']}")
    print(f"  verifier    {deployed['AttestationVerifier']}")
    print(f"  measurement {deployed['expectedMeasurement']}")
    print(f"  source      {deployed.get('attestationSource')}")
    print(f"  assets      {', '.join(a['symbol'] for a in assets)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
