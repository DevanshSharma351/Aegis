# Proof of Innocence: why the swap is blocked, and what running our own node would take

Investigated against
[Railgun-Community/private-proof-of-innocence](https://github.com/Railgun-Community/private-proof-of-innocence).

**Conclusion: technically possible, not worth it for this deployment.** The
blocker is not infrastructure — it is that a node we run cannot serve the list
the SDK requires, and the workaround makes the proof attest nothing.

---

## 1. What running a POI node actually requires

| | |
|---|---|
| Runtime | Node ≥ 16.20.1, yarn |
| Database | MongoDB ^6.0 (or AWS DocumentDB via `DOCUMENT_DB_URL`) |
| Process manager | pm2 (`pm2-aggregator.config.js`, `pm2-list-provider.config.js`) |
| Containerisation | none — no Dockerfile in the repo; `./setup`, `./start-node`, `./start-dash` |
| Peer deps | `@railgun-community/wallet@10.0.1`, `shared-models@7.3.0`, and `ethers` from a **GitHub fork**: `Railgun-Community/ethers.js#v6.7.10` |

Configuration is a short `.env`:

```
NODE_CONFIGS=[{"name":"...","nodeURL":"https://...","listKey":"<64-char pubkey>"}]
PORT=8080
LIST_PROVIDER=1
pkey="<private key>"
pubkey="<public key>"      # this becomes the listKey
# CHAINALYSIS_API_KEY=""   # only for an OFAC list provider
```

## 2. Does it support Sepolia?

**Yes.** `packages/node/src/config/config-networks.ts` maps
`NetworkName.EthereumSepolia` to
`packages/node/src/config/fallback-providers/11155111-ethereum-sepolia.ts`.
Sepolia is a first-class network in the node.

## 3. Would we need to bootstrap lists, aggregators, or Mongo data?

**No.** A standalone list provider is self-contained:

- It scans shields from the Railgun deployment block, tracking progress in
  `StatusDatabase` (Mongo), and resumes from the last scanned block.
- It runs five polling loops: queue unknown shields, categorise them, validate
  them, add allowed ones as POI events, and reconcile.
- It does **not** sync from other aggregator nodes.
- Subclasses implement one abstract method, `shouldAllowShield()`. For a testnet
  list that would be `return true`.

So: a Mongo container, a config file, and a ~20-line subclass. No external data
import.

## 4. The blocker

Our wallet decides spendability from `POI.getActiveListKeys()`, which comes from

```
POI.init([...POI_REQUIRED_LISTS, ...customPOILists], nodeInterface)
```

`POI_REQUIRED_LISTS` contains exactly one Active list:

```json
{ "key": "efc6ddb59c098a13fb2b618fdae94c1c3a807abc8fb1837c93620c9143ee9e88",
  "type": "Active",
  "name": "Chainalysis OFAC Sanctions API" }
```

A list's key **is the list provider's public key**. A node we run generates our
keypair, so it serves a list keyed by *our* pubkey. The wallet would ask it for
merkle proofs under `efc6ddb5…`, the node would not have that list, and the
spend would fail exactly as it does today.

`customPOILists` does not help: it *appends* to the required lists, so the
Chainalysis entry stays required.

### The only way through, and why it is not worth taking

`POI_REQUIRED_LISTS` is a plain, non-frozen array, and `POI.init` is exported
from `@railgun-community/engine`. Both are verifiably mutable:

```
isArray: true | frozen: false | length: 1
POI exported: function
```

So we could replace the required list with our own before `startRailgunEngine`.
The Groth16 proof would still be real, and the swap would execute.

But consider what the proof would then assert. Proof of Innocence proves a note's
history is in a list of non-sanctioned activity. Substituting a list we generate,
operate, and whose `shouldAllowShield()` returns `true` unconditionally, means
the proof attests membership in a set that admits everything. The cryptography is
untouched; the claim it carries becomes vacuous.

Presenting that as "private, compliant execution" would be misleading. Running a
genuinely meaningful private list would require real screening — the Chainalysis
API path the repo supports — which is a compliance integration, not a hackathon
task.

## 5. Cost estimate, had we proceeded

| Step | Estimate |
|---|---|
| Dockerfile for the node (none exists) + Mongo service | 1 h |
| Build against the ethers GitHub fork, Node-16-era deps | 1–3 h, main risk |
| Allow-all list provider subclass + keypair + config | 45 min |
| Override the required list in the sidecar | 30 min |
| Wait for the node to scan Sepolia and emit a POI event for our shield | unknown |
| Version skew: node targets wallet 10.0.1 / shared-models 7.3.0; we run 10.9.0 / 8.0.1 | unquantified |

The `ppoi_*` JSON-RPC method names are unchanged between those versions, so the
wire protocol probably still matches — but "probably" across a two-minor-version
gap, on a repo with no container story, is not a good bet against a deadline.

## 6. Where this leaves the pipeline

Unchanged and honest:

- Shield works and is [demonstrated on-chain](https://sepolia.etherscan.io/tx/0x15a77bfa97e4f47b4232ef5f5ccad4a790ec0b34c41a5ed55e3856b413cfa361).
- Balance scanning works; `/balances` reports `spendable: 0` for a POI-pending note.
- `POST /unshield-swap-reshield` returns **HTTP 501** naming the missing
  configuration, rather than failing obscurely minutes into proof generation.
- The full unshield → Uniswap V3 → reshield path is written, typechecked, and
  unit-tested. Set `RAILGUN_POI_NODE_URL` to a real aggregator and it runs
  unchanged.

## 7. If you want to revisit it

Two routes that do not involve faking a list:

1. **Ask Railgun for a Sepolia aggregator URL.** Their Discord/docs may list a
   current one; the endpoints reachable during this investigation
   (`ppoi-agg.horsewithsixtimelegs.com`, `poi.railgun.org`) did not resolve, and
   `poi-node.terminal3.io` returned a Vercel `DEPLOYMENT_NOT_FOUND`.
2. **Demonstrate privacy on a network with a live POI aggregator** — Ethereum
   mainnet has one. The sidecar is network-parameterised through
   `shared/config/network.json`; the Uniswap V3 addresses and
   `NetworkName`/`CHAIN` constants in `src/engine.ts` would need updating, but no
   architectural change.
