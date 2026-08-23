# Integration tests

Runs the real attestation chain end to end against a local Anvil node:

```
Python enclave code   computes the decision hash
Python oracle code    verifies a quote and signs the proof
Solidity contracts    verify that proof and record the decision
```

```bash
npm install
npm test
```

Requires `anvil` and `forge` on PATH, and `python` with `eth-account` installed.

## Why these tests exist

The value is in the seams. Those three components live in different languages
and each reimplements part of the same encoding — keccak domain separators, ABI
packing, the EIP-191 envelope. A mismatch between any two of them shows up
on-chain as an `UnauthorizedSigner` revert naming a plausible-looking wrong
address, which is a miserable thing to debug from a transaction receipt.

These tests fail at the exact seam instead.

## What is covered

| Test | The failure it would catch |
|---|---|
| accepts a Python-signed proof | keccak/ABI/EIP-191 divergence across languages |
| emits no amount data | a privacy regression in the event |
| rejects a replayed decision | the vault's replay guard being wrong |
| rejects a different measurement | measurement binding not enforced |
| rejects a proof from another chain | missing chain-id domain separation |
| rejects a non-bound caller | access control on `rebalance` |
| exposes no value-moving function | a withdrawal path appearing in the vault |
| counts each rebalance once | a rejected attempt leaving state behind |

The privacy test does not merely check the field names — it asserts that the
allocation values (0.9 / 0.1, in several plausible fixed-point scalings) appear
nowhere in the encoded log data or topics.

## What is deliberately not covered

**The ERC-4337 leg.** Pimlico has no Anvil endpoint, so covering it would mean
running a local Alto bundler — and what that would prove (that ZeroDev can sign
a UserOperation) is not what these tests are for. The account-binding logic it
depends on is asserted by `scripts/verify_deployment.sh` against the live
deployment, where it actually matters.

**Railgun proof generation and broadcast.** Needs a funded shielded balance and
a POI aggregator, costs real gas, and takes minutes. That belongs in
`scripts/run_full_pipeline.sh`.

## Anvil, not Sepolia

Fast, free, repeatable, no faucet dependency. `beforeAll` spawns Anvil, deploys
both contracts with `forge create`, and binds a stand-in smart account exactly
as the real bootstrap does.

## What this file used to be

The previous version wrapped the whole pipeline in a try/catch, logged a warning
on failure, and asserted `expect(true).toBe(true)`. It could not fail, and so
told you nothing.
