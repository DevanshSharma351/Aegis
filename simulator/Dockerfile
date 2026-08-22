# =============================================================================
# dstack guest-agent simulator
# =============================================================================
# Stands in for the TEE guest agent during local development. In a real dstack
# CVM this process is supplied by the host and the enclave simply finds its
# socket at /var/run/dstack/dstack.sock; running it as a sibling container here
# means the enclave's attestation code path is byte-for-byte the same in both
# environments — there is no "if simulator" branch anywhere in enclave/.
#
# What is NOT the same: a simulator quote is not signed by Intel. It carries a
# canned attestation blob with the caller's report_data patched in. It proves
# the plumbing works; it proves nothing about hardware. The attestation source
# is surfaced end-to-end (enclave /health, deployed.json, and the oracle's
# response) so this can never be silently mistaken for a hardware attestation.
#
# The binary is glibc-linked (not musl) and needs GLIBC >= 2.39, which rules out
# alpine and debian:bookworm — hence ubuntu:24.04.
# Populate simulator/bin/dstack-simulator via scripts/fetch_simulator.sh.
# =============================================================================

FROM ubuntu:24.04

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY bin/dstack-simulator /usr/local/bin/dstack-simulator
COPY config/ /etc/dstack-sim/

RUN chmod +x /usr/local/bin/dstack-simulator \
    && mkdir -p /var/run/dstack

WORKDIR /etc/dstack-sim

# The simulator resolves relative paths against its working directory and reads
# its listen addresses from dstack.toml (absolute paths under /var/run/dstack).
CMD ["/usr/local/bin/dstack-simulator"]
