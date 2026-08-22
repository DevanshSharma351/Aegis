# Aegis frontend

Next.js 16 / React 19. Reads live Sepolia state — no backend, no API server.

```bash
npm install
npm run dev      # predev regenerates lib/generated/deployment.ts from shared/
```

## Where the data comes from

Everything on the page is either read from chain at runtime or generated from
`shared/` at build time. Nothing is hardcoded.

| Source | What |
|---|---|
| `scripts/sync_frontend_config.py` | addresses, ABIs, expected measurement, attestation source, asset whitelist, session-key policy |
| `publicClient` (viem) | `expectedMeasurement`, `sessionKey`, `sessionKeySet`, `owner`, `whitelistedAssets`, `rebalanceCount`, `lastRebalanceAt` |
| `logClient` (viem) | `RebalanceExecuted` events since the deploy block |

`lib/generated/deployment.ts` is generated — do not edit it. `predev` and
`prebuild` regenerate it, so a redeploy propagates by rerunning either.

## Two RPC clients, on purpose

`logClient` exists because Alchemy's free tier caps `eth_getLogs` at a **10
block range**:

> Under the Free tier plan, you can make eth_getLogs requests with up to a 10
> block range.

The execution log needs every event since deployment — thousands of blocks.
Chunking that into 10-block windows would be hundreds of requests, so log
queries go to a public endpoint that serves the full range in one call.
Ordinary contract reads still use the configured primary.

No API key is required for any of it.

## The honesty rules this UI follows

The pitch is "don't trust our UI, verify the proofs yourself". That only works
if the UI never shows a proof it doesn't have.

**Green means hardware.** The attestation badge is green only when the source is
`hardware-tdx` *and* the on-chain measurement matches this build. A simulator
run is amber with an explicit disclosure, because a simulator quote exercises
every code path and proves nothing about hardware.

**No amounts, ever.** `useExecutionLog` renders the decision hash, timestamp,
and sequence — the entirety of what `AegisVault` emits. It does not go looking
for balances elsewhere to enrich the view. That absence is the product.

**Claims are derived, not asserted.** "0 withdrawal functions" comes from
scanning the compiled ABI at runtime. Add a `transfer` to the vault and the
badge flips on its own.

**Verification is not gated.** The Trust Center and Activity Log render without
a wallet. Requiring a connection to see public proofs would defeat publishing
them. Deposit and admin actions stay gated, because those need an account.

## What was removed

The original components carried fabrications that a reader could not distinguish
from real data:

- `TrustCenter` displayed "Verified (SGX Enclave)", "Hardware Mode", MRENCLAVE
  `0x8f3a9b4d…`, a whitelist including WBTC, and a downloadable JSON labelled as
  an Intel SGX quote. This deployment runs Intel **TDX** through the dstack
  *simulator*, holds only WETH and USDC, and has no MRENCLAVE.
- `ActivityLog` rendered three invented entries with fabricated transaction
  hashes, linked to `etherscan.io` (mainnet), where they do not exist.
- `StatsFooter` showed "99.99% Platform Uptime" and "2.4M Context Windows" —
  neither measured anywhere.
- `DepositorView` set a fake hash after a 2-second timeout, indistinguishable
  on screen from a real deposit.
- `DocsSection` described Intel SGX and MRENCLAVE.
- `Web3Provider` offered mainnet, Polygon, Optimism, Arbitrum and Base but
  **not Sepolia**, the only chain the contracts are on.

## Deposits

`DepositorView` explains how to shield rather than doing it. The shield path is
real and works (`railgun-sidecar/src/shield.ts`), but the sidecar holds the
wallet mnemonic and runs on an internal-only Docker network with no published
port. Exposing it to a browser to make a button work would undo that isolation.

## Dependency note

`wagmi` is pinned to `^2.19.5`. RainbowKit's newest release (2.2.11)
peer-depends on `wagmi@^2.9.0` and there is no RainbowKit build for wagmi 3 yet;
the original `wagmi@^3.7.6` made the dependency tree unresolvable and `npm
install` failed outright.

## Checks

```bash
npm run typecheck
npm run lint
npm run build
```
