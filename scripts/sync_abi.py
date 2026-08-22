#!/usr/bin/env python3
"""
Regenerate shared/abi/*.json from the Foundry build output.

Run after any contract change. The frontend and the identity service both read
these files, and a hand-edited or stale ABI produces decode failures that look
like network errors rather than like the version skew they are.

Writes without a BOM: the previous files were produced by PowerShell
redirection and carried one, which breaks JSON.parse and bundler imports.
"""

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONTRACTS = ("AegisVault", "AttestationVerifier")


def main() -> int:
    out_dir = ROOT / "contracts" / "out"
    if not out_dir.exists():
        print("contracts/out not found. Run 'forge build' in contracts/ first.", file=sys.stderr)
        return 1

    abi_dir = ROOT / "shared" / "abi"
    abi_dir.mkdir(parents=True, exist_ok=True)

    for name in CONTRACTS:
        artifact = out_dir / f"{name}.sol" / f"{name}.json"
        if not artifact.exists():
            print(f"missing build artifact: {artifact}", file=sys.stderr)
            return 1

        abi = json.loads(artifact.read_text(encoding="utf-8"))["abi"]
        (abi_dir / f"{name}.json").write_text(
            json.dumps(abi, indent=2) + "\n", encoding="utf-8"
        )

        functions = sorted(e["name"] for e in abi if e.get("type") == "function")
        print(f"{name}: {len(abi)} entries ({len(functions)} functions)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
