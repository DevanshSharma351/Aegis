# Attestation oracle

Verifies TDX quotes off-chain and signs the compact statement that
`AttestationVerifier.sol` checks on-chain.

This is the component carrying the trust the contract cannot. The contract
verifies one ECDSA signature; everything that signature is worth depends on the
checks performed here.

## The checks, in order

Every one aborts on failure. None are advisory.

**1. Structural parse.** The blob is a TDX v4/v5 quote with TEE type TDX. An SGX
quote reaching this path is a configuration error, not a malformed input, and is
named as such.

**2. Decision binding.** `report_data[:32] == decisionHash`. Without this, a
valid quote could be paired with an arbitrary decision — the exact attack the
attestation exists to prevent.

**3. Event log replay.** Each RTMR starts at zero and is extended as
`RTMR = SHA384(RTMR ‖ digest)` for every event recorded against it. If the replay
reproduces the quote's attested registers, the log is authentic: no entry can be
added, removed, or reordered without changing the final value.

**4. Compose hash from the attested log.** `compose_hash` pins the container
images and is *not* carried in the TD report body — only in an event-log entry.
Reading it from the request body instead would make checks 1–3 pointless.
Duplicate entries are rejected rather than resolved by position, so an appended
attacker-chosen value cannot be silently preferred.

**5. Measurement allowlist.**
`keccak(mrtd ‖ rtmr0 ‖ rtmr1 ‖ rtmr2 ‖ composeHash)` must appear in
`AEGIS_MEASUREMENT_ALLOWLIST`, when one is configured.

**6. Hardware signature chain.** Under `AEGIS_REQUIRE_HARDWARE`, the quote is
verified through the dstack verifier against Intel PCS collateral. If the
verifier URL is unset in that mode, the oracle refuses to sign — silently
degrading to no signature verification would turn the strongest check in the
pipeline into a no-op.

## What the signature covers

```solidity
keccak256(abi.encode(
    ATTESTATION_TYPEHASH,
    block.chainid,     // not replayable to another chain
    address(this),     // not replayable to another verifier
    decisionHash,      // not reusable for another decision
    measurement,       // not usable by another enclave build
    expiry             // bounded lifetime if leaked
))
```

wrapped in the EIP-191 `personal_sign` envelope.

`tests/test_verifier.py` pins the resulting digest against a value read from a
deployed contract, so drift between the Python and the Solidity is caught by the
test suite rather than by an `UnauthorizedSigner` revert in production.

## Trust boundary

A compromised oracle **can** sign a statement naming a measurement no real
enclave produced.

A compromised oracle **cannot** fabricate a decision, because the decision hash
is read out of the quote's `report_data` rather than taken from the request.

Removing the first requires on-chain DCAP verification. That is the documented
upgrade path, and it is why `AEGIS_MEASUREMENT_ALLOWLIST` exists in the meantime:
with an allowlist set, a compromised oracle is confined to enclave builds an
operator has already approved.

## Configuration

| Variable | Effect |
|---|---|
| `AEGIS_ORACLE_PRIVATE_KEY` | signing key; must match the deployed `oracleSigner` |
| `AEGIS_REQUIRE_HARDWARE` | refuse simulator quotes |
| `AEGIS_MEASUREMENT_ALLOWLIST` | comma-separated measurements; empty = any build |
| `AEGIS_DSTACK_VERIFIER_URL` | required when hardware is required |
| `AEGIS_ATTESTATION_TTL_S` | signature lifetime, default 900s |

An empty allowlist is correct only during bootstrap — the first deploy needs the
oracle to sign for a measurement not yet recorded anywhere. Populate it
immediately afterwards; `scripts/verify_deployment.sh` warns while it is empty.

## API

Internal network only.

```
GET  /health    signer address, enforcement posture, allowlist size
POST /attest    { quote, decision_hash, event_log, source,
                  verifier_address, chain_id }
```

`/attest` returns 422 with the failing stage named — "attestation rejected" alone
is useless when the chain has six distinct checks. The success response carries
`checksPerformed`, so the pipeline can print what was actually verified rather
than asserting that something was.
