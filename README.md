# Aegis

**An autonomous trading agent that reasons inside hardware-isolated compute and executes through shielded, MEV-proof rails — verifiable end-to-end, visible to no one.**

---

## Architecture Overview

Aegis is a monorepo containing five workstreams that compose into a single verifiable autonomous trading pipeline:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Aegis Pipeline                               │
│                                                                     │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────────┐  │
│  │ Enclave  │───▶│ Identity │───▶│ Railgun  │───▶│  AegisVault  │  │
│  │ (TEE)    │    │ (4337)   │    │ Sidecar  │    │  (on-chain)  │  │
│  │          │    │          │    │          │    │              │  │
│  │ SLM +    │    │ Session  │    │ Shielded │    │ Attestation  │  │
│  │ Signal   │    │ Key      │    │ Swap     │    │ Verified     │  │
│  └──────────┘    └──────────┘    └──────────┘    └──────────────┘  │
│       ▲                                                ▲            │
│       │            shared/config/                      │            │
│       └────────────────────────────────────────────────┘            │
└─────────────────────────────────────────────────────────────────────┘
```

### Workstreams

| ID | Name | Directory | Description |
|----|------|-----------|-------------|
| 0 | Shared Config | [`shared/`](shared/) | Asset whitelist, network config, policy rules, ABI stubs |
| A | Compute / TEE | [`enclave/`](enclave/) | FastAPI service: quant signals → SLM allocation → dstack attestation |
| B | Identity | [`identity/`](identity/) | ZeroDev Kernel smart account + session key scoped to the vault |
| C | Railgun Sidecar | [`railgun-sidecar/`](railgun-sidecar/) | Shielded execution via Railgun Cookbook recipes |
| D | Contracts | [`contracts/`](contracts/) | AegisVault + AttestationVerifier (Foundry/Solidity) |
| E | Frontend | [`frontend/`](frontend/) | Next.js dashboard reading on-chain attestation + execution logs |

### Build Order

1. **Shared config** (`shared/`) — everything reads from here
2. **Enclave** (`enclave/`) + **Contracts** (`contracts/`) — parallelizable
3. Freeze enclave build → finalize AttestationVerifier's measurement constant
4. **Identity** (`identity/`) — needs deployed vault address
5. **Railgun Sidecar** (`railgun-sidecar/`) — needs live session key
6. Integration tests (`tests/`)
7. **Frontend** (`frontend/`) — UI shell built in parallel, data layer wired last

### Key Design Decisions

- **Zero withdrawal functions** on AegisVault — defense-in-depth, not just policy enforcement
- **Two-phase deployment** resolves the vault↔session-key circular dependency
- **On-chain events emit only hashes + timestamps**, never amounts — privacy at the log layer
- **Railgun sidecar is network-isolated** — reachable only from the enclave container

### Deployment & Integration Reminders

**Important: To ensure successful end-to-end integration across all workstreams, note the following:**

1. **Vault & Session Key Bootstrapping (The Circular Dependency)**:
   - Deploy the `AegisVault` first (leaving `sessionKey` unset).
   - Once deployed, generate the ZeroDev session key scoped *specifically* to that vault address (Workstream B).
   - Finally, the vault owner must call `setSessionKey` on `AegisVault` to link them.
2. **Environment Variables**:
   - `DEPLOYER_PRIVATE_KEY`: Only used once to deploy the contracts (Workstream D).
   - `AEGIS_OWNER_PRIVATE_KEY`: The EOA that controls the smart account and Vault owner functions (do not log this).
   - `SESSION_KEY_PRIVATE_KEY`: Must **never** be logged or committed. In production, this should ideally be derived dynamically from the TEE using `dstack-sdk`.
3. **Attestation Constraints**:
   - The `AttestationVerifier` uses a hardcoded `expectedMeasurement` (MRTD/RTMR hash). Once the enclave Docker image (Workstream A) is strictly frozen, this measurement must be updated on-chain to match the frozen image. Any rebuild of the enclave changes the measurement and requires a verifier update.

### Getting Started

```bash
cp .env.example .env
# Fill in your API keys and secrets
# Then follow each workstream's README in build order
```

## License

Private — not open source.
