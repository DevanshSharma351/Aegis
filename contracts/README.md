# Contracts

Two contracts. One records attested decisions; the other decides whether an
attestation is worth recording.

## AegisVault

Records that an attested rebalance happened. It does not hold or move value.

**No withdrawal function exists.** No token transfer, no `receive`, no
`fallback`, no `delegatecall`. This is structural rather than policy: session-key
permissions are enforced by an SDK and an on-chain module, both of which are code
that can have bugs, whereas a missing function cannot. Even a fully compromised
owner key and a fully compromised session key cannot extract value, because no
code path moves value.

`AegisVault.t.sol` asserts this against the compiled artifact — it probes 512
pseudo-random selectors plus the common withdrawal signatures, and requires every
one that is not a declared function to revert. The claim is tested, not just
commented.

**`sessionKey` holds the smart account, not the signing EOA.** A UserOperation
executes with `msg.sender == account`. See `identity/README.md`.

**Replay protection.** `executedAt[decisionHash]` records every executed
decision. Without it, the same oracle-signed proof could be resubmitted
repeatedly inside its validity window.

**The event carries a hash, a timestamp, and a sequence number.** No allocations,
no amounts, no asset identifiers. An observer learns *that* the agent acted and
*when*, and can verify the decision was attested — but nothing about the position.
The actual movement happens inside Railgun's shielded pool, so there is no public
counterpart to correlate against.

## AttestationVerifier

Checks that a decision came from a known enclave build.

This deployment uses **relayed verification**: the full DCAP quote is verified
off-chain by the oracle, which signs a compact statement checked here. The
alternative — on-chain DCAP verification via something like `dcap-qvl` — costs
millions of gas and requires on-chain Intel PCS collateral.

The trade-off is bounded and explicit:

- The oracle **cannot** forge a decision the enclave did not make, because the
  decision hash is bound into the quote's `report_data`, which the oracle checks.
- The oracle **can**, if compromised, sign a statement naming a measurement no
  real enclave produced. That is the residual assumption, and it is removed by
  moving `verify` to on-chain DCAP verification.

What is enforced on-chain:

| Check | Prevents |
|---|---|
| signature recovers to `oracleSigner` | forged proofs |
| statement covers `decisionHash` | reusing a proof for another decision |
| `measurement == expectedMeasurement` | a different enclave build |
| statement covers `block.chainid` | cross-chain replay |
| statement covers `address(this)` | replay to a sibling verifier |
| `block.timestamp <= expiry` | indefinite use of a leaked signature |
| `s` in the lower half of the curve order | signature malleability |

`verify` is `view` and reverts with named errors rather than returning `false`,
so callers get an actionable reason and the function can also be used for
off-chain pre-flight via `eth_call`.

### Why `expectedMeasurement` is mutable

Any legitimate change to the enclave image — a dependency bump, a model update —
changes the measurement. If this were immutable, every rebuild would require
redeploying this contract *and* `AegisVault`, whose `attestationVerifier`
reference is immutable. That is a full protocol redeploy per rebuild, which is
not operable.

The cost is that `owner` can point the protocol at a different enclave build.
Every rotation emits `ExpectedMeasurementUpdated`, so the change is publicly
auditable. Production deployments should put `owner` behind a timelock or
multisig, or transfer it to `address(0)` to freeze the build permanently.

## Build and test

```bash
forge build
forge test -vv
```

36 tests. The interesting ones are the negative cases: wrong measurement, expired
proof, cross-chain replay, sibling-verifier replay, malleable signature, replayed
decision, and the exhaustive selector probe.

## Deploying

Use `scripts/deploy_sepolia.sh` rather than calling `forge script` directly. It
reads the measurement from the **running** enclave and passes it in, because
deploying against a measurement nobody has observed is exactly the failure this
contract exists to prevent. `Deploy.s.sol` requires the value via
`vm.envBytes32` and has no placeholder default.
