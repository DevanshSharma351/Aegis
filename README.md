# Aegis

An autonomous rebalancing agent that reasons inside a TEE, proves what it
decided on-chain, and executes through Railgun's shielded pool.

Backend only. The frontend lives on a separate branch and reads
`shared/config/deployed.json` plus `shared/abi/`.

---

## The chain of custody

Every link exists to close a specific gap. Read left to right:

```
  enclave                oracle                 chain                  railgun
  ───────                ──────                 ─────                  ───────
  fetch OHLC
  compute signals
  ask the SLM
    │
    ├─ decisionHash = keccak(canonical JSON)
    ├─ TDX quote with decisionHash in report_data
    │
    └──────────────────▶ parse the quote
                         report_data == decisionHash?
                         event log replays to RTMR0-3?
                         compose hash from the *attested* log
                         measurement = keccak(mrtd‖rtmr0-2‖composeHash)
                         measurement allowlisted?
                           │
                           └─ sign(chainId, verifier, decisionHash,
                                   measurement, expiry)
                                        │
                                        └──────▶ recover == oracleSigner?
                                                 measurement == expected?
                                                 not expired?
                                                 not already executed?
                                                    │
                                                    └─ RebalanceExecuted
                                                       (hash, timestamp, seq)
                                                                │
                                                                └──▶ shield
                                                                     unshield
                                                                     swap
                                                                     reshield
```

The decision hash is bound into the quote's `report_data`, so the oracle cannot
attest a decision the enclave did not make. The measurement is derived from the
quote's own registers, so the enclave cannot misreport its own identity. The
signature covers `chainId` and the verifier address, so a proof minted for one
deployment cannot be replayed against another. The vault records every executed
decision hash, so a proof cannot be replayed against the same deployment inside
its validity window.

## What each service is

| Service | Language | Holds | Reachable from |
|---|---|---|---|
| `dstack-simulator` | — | nothing | internal |
| `enclave` | Python | nothing secret | host `:8000` + internal |
| `oracle` | Python | attestation signing key | internal only |
| `identity` | TypeScript | session key | internal only |
| `railgun-sidecar` | TypeScript | wallet mnemonic | internal only |

The three services holding secrets publish no ports. The enclave is the only one
on both networks, which makes it the sole path in — and
`scripts/verify_deployment.sh` asserts that rather than trusting the config.

## Current deployment (Sepolia)

Deployed and exercised end to end on 2026-08-23. `shared/config/deployed.json`
is the machine-readable source; this table is for orientation.

| | |
|---|---|
| AegisVault | [`0xB7B42f53f69D6a973a34c77EB690a828eb91bCD0`](https://sepolia.etherscan.io/address/0xB7B42f53f69D6a973a34c77EB690a828eb91bCD0) |
| AttestationVerifier | [`0x17227Df878fDB2D1AdC67891c339E741218161b7`](https://sepolia.etherscan.io/address/0x17227Df878fDB2D1AdC67891c339E741218161b7) |
| Smart account (bound) | `0x61e7eDBD1C14C7F0B14513958e94d9f58770E662` |
| Oracle signer | `0x0212AdAc560383416B4973Ded96c35Dcb912531A` |
| Enclave measurement | `0x94261f53…e17a1af4` |
| Attestation source | `simulator` |

Verified live:

- [`RebalanceExecuted #1`](https://sepolia.etherscan.io/tx/0x31f617c0959671839c4925042d70c24fcd18b8444b3ea83e1332987f7652a3c8)
  — enclave decision → oracle proof → ERC-4337 UserOperation → on-chain event.
  The log carries one indexed hash and two words (timestamp, sequence); no
  amount field exists.
- [Railgun shield](https://sepolia.etherscan.io/tx/0x15a77bfa97e4f47b4232ef5f5ccad4a790ec0b34c41a5ed55e3856b413cfa361)
  — 0.002 WETH into the shielded pool. The 0zk balance reads
  `1995000000000000`, i.e. the amount less the 25 bps protocol fee.

Not executed: the shielded swap. It needs a POI aggregator (gap 2 below), and
the sidecar returns HTTP 501 naming that rather than failing obscurely.

## Getting it running

```bash
cp .env.example .env      # fill in the keys
scripts/fetch_simulator.sh
docker compose build
```

Then, in order — the order matters, see "Bootstrap" below:

```bash
scripts/deploy_sepolia.sh    # reads the live measurement, deploys, syncs ABIs
scripts/bootstrap.sh         # derives the account, approves, binds (one-shot)
scripts/verify_deployment.sh # confirms all of the above
scripts/run_full_pipeline.sh # end-to-end
```

## Bootstrap: the circular dependency

`AegisVault` needs the executing account's address to enforce policy. The
session key's policy needs the vault's address to scope itself. Neither can be
created knowing the other.

The resolution is that an ERC-4337 Kernel account address is **counterfactual** —
deterministic in `(owner, entryPoint, kernelVersion, index)` and computable
before any transaction exists. So:

1. Deploy the vault with `sessionKey` unset.
2. Derive the smart account address. No transaction.
3. Build a session-key approval scoped to the vault.
4. `setSessionKey(smartAccount)` — callable exactly once.

**Step 4 binds the smart account, not the session-key EOA.** A UserOperation
executes with `msg.sender == account`; the EOA that signs it never appears as
the caller. Binding the EOA yields a vault that reverts `NotSessionKey()` on
every rebalance forever — and since the setter is one-shot, that is
unrecoverable without a redeploy. `setVaultSessionKey.ts` reads the value back
after writing, for this reason.

## The security model, stated plainly

**What is enforced on-chain.** The vault has no withdrawal function, no token
transfer, no `receive`, no `fallback`, and no `delegatecall`. This is structural,
not policy: session-key permissions are code that can have bugs, whereas a
missing function cannot. Even a fully compromised owner key and a fully
compromised session key cannot extract value, because no code path moves value.
`AegisVault.t.sol` asserts this against the compiled artifact by probing 512
undeclared selectors.

**What the session key can do.** Call `rebalance` on one contract, with zero
value, once per day. Its worst case is writing junk to an execution log.

**What the oracle is trusted for.** This deployment uses relayed verification:
the full DCAP quote is checked off-chain and the oracle signs a compact
statement. A compromised oracle can sign for a measurement no real enclave
produced. It *cannot* fabricate a decision, because the decision hash comes out
of the quote's `report_data`. Removing this assumption means on-chain DCAP
verification, which costs millions of gas and needs on-chain Intel collateral.

**What the simulator does not prove.** A simulator quote is a canned attestation
blob with `report_data` patched in. Every structural check still runs and still
catches a mismatched decision, a forged event log, or an unexpected measurement.
What it cannot establish is that any of it ran on real hardware. The attestation
source is carried through `/health`, `deployed.json`, the oracle's response, and
the pipeline summary, so it is never left to inference. Set
`AEGIS_REQUIRE_HARDWARE=true` to make the oracle refuse simulator quotes.

**Key separation.** Four roles, four keys: deployer, owner, session key, oracle.
Reusing one collapses four blast radii into one. The owner key is deliberately
*not* passed to any container — it is needed only by the host-side bootstrap.

## Known gaps

These are real and deliberately not papered over:

1. **No on-chain DCAP verification.** Relayed verification instead; the trade-off
   is documented above and in `AttestationVerifier.sol`.
2. **Railgun spending needs a POI aggregator.** Sepolia is POI-required.
   Shielding and balance scans work without one; unshield/swap/reshield cannot
   generate a proof. See `railgun-sidecar/README.md`.
3. **The session key does not yet authorise Railgun.** `getSubmitter()` is the
   seam; leaving it unswitched is a deliberate scope decision, explained there.
4. **The session key is a plaintext env var.** It should be TEE-derived via
   `DstackClient.get_key`; the upgrade path is documented in
   `identity/src/clients.ts`.
5. **`expectedMeasurement` is owner-mutable.** Immutability would make every
   enclave rebuild a full protocol redeploy. Every rotation emits an event.

## Layout

```
shared/
  config/      assets, network, policy, deployed  — one source of truth
  abi/         generated from the Foundry build by scripts/sync_abi.py
  pylib/       aegis_tdx: quote parsing, event-log replay, measurement
               derivation. Shared verbatim by enclave and oracle so the two
               cannot drift.
contracts/     AegisVault, AttestationVerifier, Foundry tests
enclave/       FastAPI: data -> signals -> SLM -> TDX quote
oracle/        quote verification + attestation signing
identity/      ERC-4337 account, session key, submission
railgun-sidecar/ shield, unshield-swap-reshield
simulator/     dstack guest-agent simulator container
scripts/       deploy, bootstrap, verify, run
tests/         cross-language integration tests on Anvil
```

## Tests

```bash
(cd contracts && forge test)      # 36 tests
(cd enclave  && python -m pytest) # 64 tests
(cd oracle   && python -m pytest) # 25 tests
(cd tests    && npm test)         # 9 cross-language tests on Anvil
```

The integration suite deploys real contracts to Anvil, computes decision hashes
with the enclave's Python, signs proofs with the oracle's Python, and verifies
them in Solidity — so a divergence in keccak domains, ABI packing, or the
EIP-191 envelope fails at the seam instead of on-chain.
