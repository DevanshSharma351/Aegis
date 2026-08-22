# Enclave

Produces one attested rebalance decision per request. Runs inside a dstack CVM
(Intel TDX).

```
GET  /health       liveness + attestation-source disclosure
GET  /measurement  this build's code identity
POST /rebalance    data -> signals -> SLM -> TDX quote
```

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
