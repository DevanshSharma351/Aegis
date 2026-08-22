# dstack guest-agent simulator

Stands in for the TEE guest agent during local development.

In a real dstack CVM this process is supplied by the host, and the enclave simply
finds its socket at `/var/run/dstack/dstack.sock`. Running it as a sibling
container reproduces that layout exactly, which is why there is no `if simulator`
branch anywhere in `enclave/` — the same `DstackClient` call resolves the same
socket in both environments.

## What a simulator quote is and is not

It **is** a structurally real TDX v4 quote: correct header, correct TD report
body, real measurement registers, and — because `patch_report_data = true` in
`config/dstack.toml` — the caller's `report_data` written into the right field.
Every structural check in the pipeline runs against it and can fail against it.

It **is not** signed by Intel. The attestation payload is a canned blob from
`config/attestation.bin`. Nothing about it proves the code ran on real hardware.

That distinction is carried explicitly through `/health`, `deployed.json`, the
oracle's response, and the pipeline summary, so it is never left to inference.
Set `AEGIS_REQUIRE_HARDWARE=true` to make the oracle refuse to sign for it.

## Setup

The 26 MB binary is not committed:

```bash
scripts/fetch_simulator.sh
```

It copies from a local dstack checkout if there is one (including the vendored
`dstack-sim/`), and otherwise downloads a pinned release. Override with
`DSTACK_CHECKOUT` or `DSTACK_SIMULATOR_VERSION`.

The binary is glibc-linked and needs GLIBC ≥ 2.39, which is why the image is
`ubuntu:24.04` rather than alpine or debian:bookworm.

## Sockets

`config/dstack.toml` places all four sockets under `/var/run/dstack`, shared with
the enclave through the `dstack-sockets` named volume. The enclave mounts it
read-only.

| Socket | Purpose |
|---|---|
| `dstack.sock` | current guest API — what `DstackClient` uses |
| `tappd.sock` | legacy API, for the deprecated `TappdClient` |
| `external.sock` | external API |
| `guest.sock` | guest API |

## Poking at it directly

```bash
docker compose exec dstack-simulator sh -c \
  'curl -s --unix-socket /var/run/dstack/dstack.sock \
     -X POST -H "Content-Type: application/json" -d "{}" http://localhost/Info'
```

`Info` returns `tcb_info` with `mrtd`, `rtmr0-3`, and `compose_hash` — the inputs
to the enclave measurement. `GetQuote` takes `{"report_data": "<64 hex chars>"}`
and returns a quote with that value patched in at offset 520 of the TD report
body.

## Moving to real hardware

1. Remove the `dstack-simulator` service from `docker-compose.yml`.
2. Replace the enclave's `dstack-sockets` volume with a bind mount of the host's
   `/var/run/dstack.sock`.
3. Set `AEGIS_ATTESTATION_SOURCE=hardware-tdx`.
4. Set `AEGIS_REQUIRE_HARDWARE=true` and `AEGIS_DSTACK_VERIFIER_URL` on the
   oracle.
5. Re-deploy: the measurement will differ, because real MRTD and RTMR values
   replace the simulator's canned ones.

No application code changes at any step.
