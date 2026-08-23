# Enclave

Produces one attested rebalance decision per request. Runs inside a dstack CVM
(Intel TDX).

```
GET  /health              liveness + attestation-source disclosure
GET  /measurement         this build's code identity
POST /rebalance           data -> signals -> SLM -> TDX quote

POST /pipeline/run        start the full sequence, returns a jobId
GET  /pipeline/{jobId}    real per-stage state

GET  /railgun/status      sidecar health: POI mode + submission route
GET  /railgun/balances    shielded balances (total and POI-spendable)
GET  /railgun/gas-preflight  can the submitter afford a private swap?
POST /railgun/shield      shield an ERC-20 into the 0zk wallet
POST /railgun/private-swap  one atomic unshield -> swap -> reshield
```

## Why the browser talks to the enclave

The oracle, identity service, and Railgun sidecar are on an internal-only Docker
network with no published ports, because each holds a secret: the oracle signing
key, the session key, and the wallet mnemonic respectively. The enclave is the
only service on both networks, so it is the single controlled entry point.

The `/railgun/*` endpoints proxy to the sidecar and return its answer verbatim —
they do not reinterpret status. `/pipeline/*` orchestrates.

Orchestrating here grants the enclave **no new authority**. It still cannot sign
a UserOperation (identity holds the session key) or move shielded funds (the
sidecar holds the mnemonic). It sequences calls to components that each keep
their own secrets and their own refusals.

## The pipeline

`pipeline.py` runs the same sequence as `scripts/run_full_pipeline.sh`. The bash
script remains the CLI path; this is the same steps, reachable over HTTP.

Stages 1-3 call the same functions `/rebalance` calls — `fetch_all_assets`,
`compute_all_signals`, `query_slm`, `attest_decision` — rather than HTTP-ing this
same process. That is what makes per-stage progress real rather than cosmetic:
each stage advances only when the underlying call returns, and the code path is
identical to the one the CLI exercises. Nothing is duplicated.

Before stage 1 the run makes one read-only check: can the public submitter
actually pay for the RelayAdapt transaction? EIP-1559 makes the sender hold
`gasLimit x maxFeePerGas` up front, and Railgun's cross-contract gas limit is
~3.36M (it enforces a minimum so the reshield leg cannot be griefed) against
~1.9M typically consumed. Everything between stage 1 and the swap is expensive
and non-refundable — a UserOperation, one of the session key's rate-limited
daily slots, and minutes of Groth16 proving — so discovering a shortfall at
stage 7 wastes all of it. A failed preflight leaves **every** stage `pending`.

| Stage | What actually happens |
|---|---|
| Market Analysis | CoinGecko OHLC → SMA crossover + rolling z-score |
| AI Decision | local SLM over the signal output |
| TDX Attestation | decision hash bound into a TDX quote; measurement checked against the on-chain constant |
| Oracle Verification | quote verified off-chain, attestation signed |
| ERC-4337 Execution | UserOperation calling `AegisVault.rebalance` |
| Proof of Innocence | real precondition check: aggregator configured **and** balance POI-validated |
| Private Swap | the trade the allocation implies: Groth16 proof + atomic RelayAdapt |
| Reshield | verified by polling for the shielded balance to actually increase |
| Confirmed | final state |

A stage moves to `succeeded` only on a real result. On failure the pipeline
stops, the failing stage is named, and **downstream stages stay `pending`** — they
are never reported as succeeded.

## The decision actually drives the trade

For a while it did not. The SLM's allocation was hashed into the TDX quote,
signed by the oracle and recorded on-chain — and then the executor sold a
hardcoded WETH -> USDC amount that the HTTP caller had chosen. The attested
decision and the executed trade were unrelated, so "the agent rebalanced" was
not a claim this system could support.

`plan_rebalance` closes that gap. It values every shielded position using the
same prices the model was shown, compares the resulting weights against the
attested target, and executes the single trade that closes the largest gap.
`sellAmount` in the request is now only an upper bound: a demo can cap the size,
but the direction belongs to the decision.

One trade per run rather than a full rebalance, because each swap needs its own
Groth16 proof and the engine takes 30-60s to see a spend — a complete rebalance
runs into minutes, and a failure halfway leaves the portfolio in a state nobody
chose. The next run picks up where this one stopped, which is how a periodic
rebalancer converges anyway.

**Trades route through WETH.** The recipe is single-hop, so a pair needs a direct
Uniswap V3 pool. On Sepolia only WETH is a complete hub; USDC/DAI has no pool at
all, and a run that planned that pair died at the swap stage having already spent
a UserOperation and a rate-limit slot. When neither side of the ideal pair is
WETH, the sell leg goes into WETH instead and the next run distributes it.

Two of these are genuine gates, not labels:

- **Proof of Innocence** fails the run if no aggregator is configured or the
  balance is not yet POI-validated. It has caught both conditions live.
- **The gas preflight** stops a run before anything is spent, and demands 25%
  headroom over the current reservation. That margin was added after a run
  cleared the check at t=0 and then failed at the swap ~50s later on a ~8%
  base-fee rise, having already spent a UserOperation and a rate-limit slot.
- **Reshield** polls for up to 90s for the shielded USDC balance to increase, and
  fails if it does not. Reading once was a false-negative: the engine needs time
  to scan the new commitment, and an immediate read reported a completed reshield
  as a failure.

## What it does not do

It does not submit transactions. It produces an attested decision and stops.

Signing and submission belong to the identity service, which holds the session
key. Keeping them apart means a compromised enclave still cannot move anything
on-chain without also defeating the session-key policy.

## The three layers

**`quant/data_feed.py`** pulls OHLC candles from CoinGecko for the whitelisted
assets. It raises rather than degrading. The previous version caught per-asset
errors and substituted an empty DataFrame, which made the signal layer emit
`insufficient_data` while the pipeline still reported success — and since the
enclave attests whatever it produces, that bad decision would have carried a
perfectly valid proof.

**`quant/signal.py`** computes SMA crossovers and rolling z-scores.
Deterministic: same input, same output.

**`quant/model.py`** asks a local Ollama model for an allocation *over the signal
output*, never over raw prices. Retries up to three times, feeding the specific
validation failure back each time so a retry is corrective rather than a blind
resample. Raises if no valid allocation emerges — substituting a default would
mean attesting a decision the model never made.

## Measurement

```
keccak256("AegisEnclaveMeasurement:v1" ‖ mrtd ‖ rtmr0 ‖ rtmr1 ‖ rtmr2 ‖ composeHash)
```

`mrtd` and `rtmr0-2` pin the software stack below the workload. `compose_hash`
pins the app-compose document, which names the container images by digest — it is
the field that actually changes when this image is rebuilt.

**RTMR3 is excluded.** dstack extends it at runtime with per-instance events
(instance id, app id, key provider), so it differs between two instances of the
same image. Including it would make the measurement per-instance rather than
per-build, and every restart would require an on-chain rotation.

`GET /measurement` reports this value. `scripts/deploy_sepolia.sh` reads it from
the running enclave and burns it into the verifier's constructor;
`scripts/verify_deployment.sh` compares them and fails on drift.

## Why the model weights are baked into the image

The TEE measurement covers the container image. If the model were pulled at
container start, its weights would sit outside the measurement — and an attacker
controlling the network or the model registry could serve different weights, have
the enclave produce attacker-chosen allocations, and still pass attestation,
because nothing about the swapped weights changed the measured image.

Baking them in means any change to the model changes the image digest, the
compose hash, and the measurement — and fails verification on-chain. That is why
the image is ~7 GB.

## Attestation source

`/health` and every attestation response carry `source`: `simulator` or
`hardware-tdx`. This is stated explicitly at every layer rather than inferred,
because a simulator quote is a canned blob with `report_data` patched in. It
exercises every code path and proves nothing about hardware.

## Running against the simulator

```bash
docker compose up -d dstack-simulator enclave
curl -s localhost:8000/health      | python -m json.tool
curl -s localhost:8000/measurement | python -m json.tool
curl -s -X POST localhost:8000/rebalance | python -m json.tool
```

On real dstack hardware: drop the simulator service, bind-mount the host's
`/var/run/dstack.sock`, and set `AEGIS_ATTESTATION_SOURCE=hardware-tdx`. No
application code changes — `DstackClient` resolves the same socket either way,
which is why there is no `if simulator` branch anywhere in this directory.

## Response shape

```jsonc
{
  "allocation": { "WETH": 0.62, "USDC": 0.38 },
  "rationale": "...",
  "confidence": 0.71,
  "signals": { "WETH": { "sma_crossover": "bullish", "zscore": 0.45 } },
  "attestation": {
    "quote": "0x0400…",            // full TDX quote
    "decision_hash": "0x2f4c…",    // == report_data[:32] of that quote
    "measurement": "0x9426…",      // == AttestationVerifier.expectedMeasurement
    "compose_hash": "c143…",
    "event_log": "[…]",            // replays to the quote's RTMRs
    "source": "simulator",
    "generated_at": 1787414000
  }
}
```

## Tests

```bash
python -m pytest                                                    # unit only
DSTACK_SIMULATOR_ENDPOINT=http://localhost:8090 python -m pytest    # + integration
```

The integration tests need a live guest agent because the properties they check —
that `report_data` comes back bound, that two independent derivations of the
measurement agree, that the event log replays to the attested registers — cannot
be verified against a mock. A mock returns whatever it was told to return.
