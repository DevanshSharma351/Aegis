# Proof of Innocence on Sepolia

**Status: WORKING with a real, legitimate POI aggregator. No bypass, no simulation, no POC mode.**

An earlier revision of this document concluded that no Sepolia aggregator was
reachable and analysed what running our own would take. That conclusion was
**wrong** — it was based on probing hostnames that do not exist
(`ppoi-agg.horsewithsixtimelegs.com`, `poi.railgun.org`). The correct endpoint is
documented in Railgun's own
[developer guide](https://docs.railgun.org/developer-guide/wallet/getting-started/5.-start-the-railgun-privacy-engine).

## The working configuration

```bash
RAILGUN_POI_NODE_URL=https://ppoi.fdi.network
```

Comma-separate multiple URLs for failover; the SDK falls back in priority order.

Verified live against that endpoint:

| Check | Result |
|---|---|
| Serves `Ethereum_Sepolia` | yes — txidIndex 3383, validated 3383 (fully synced) |
| Advertises the required list | yes — `efc6ddb59c098a13fb2b618fdae94c1c3a807abc8fb1837c93620c9143ee9e88` |
| `ppoi_validated_txid` (Sepolia) | returns a real validated index and merkleroot |
| `ppoi_pois_per_list` (Sepolia) | responds correctly |
| `ppoi_merkle_proofs` (Sepolia) | responds correctly |

That list key is exactly the entry in `POI_REQUIRED_LISTS` — the Chainalysis
OFAC Sanctions API list. Nothing is substituted or relaxed.

## Proof it is actually enforcing

Before configuring the aggregator, our shielded WETH read:

```
balance = 1995000000000000    spendable = 0
```

After pointing at `ppoi.fdi.network` and rescanning:

```
balance = 1995000000000000    spendable = 1995000000000000
```

The balance did not change — the *spendability* did, because POI validation
completed. A note is only spendable once the aggregator has validated it, which
is exactly the gate working as designed. Freshly created notes show
`spendable: 0` until validation catches up; `/balances` reports both numbers so
that state is visible rather than looking like a bug.

## Why there is no POC / bypass mode in this build

It was authorised, conditionally: build one *if* no legitimate provider existed.
One exists, so none was built.

`POI_REQUIRED_LISTS` is a mutable array and `POI.init` is exported, so
substituting our own permissive list is technically possible. It was rejected
for the same reason as before: the Groth16 proof would stay real while the claim
it carries — that a note's history is in a list of non-sanctioned activity —
would become vacuous. Adding that path now would also mean shipping a
security-relevant switch with no purpose, and the risk that it is the one
someone runs by accident.

There is therefore **no simulated POI code path anywhere in this repository.**
`/health` reports `poi.mode` as either `real` (an aggregator is configured and
the required list is enforced) or `unconfigured` (spending is disabled). There is
no third value.

## Moving to another provider or to mainnet

Configuration only — no code changes:

| Environment | Change |
|---|---|
| Different Sepolia aggregator | set `RAILGUN_POI_NODE_URL` |
| Multiple aggregators, failover | comma-separate the URLs |
| Mainnet | set `RAILGUN_POI_NODE_URL` to a mainnet aggregator; the required list key is the same |
| Self-hosted node | point the variable at your own; see below |

The URL is read in `src/engine.ts::startEngine` and passed straight to
`startRailgunEngine`. Nothing else in the codebase knows or cares which
aggregator is in use.

## If you ever do want to self-host

The [private-proof-of-innocence](https://github.com/Railgun-Community/private-proof-of-innocence)
node supports Sepolia (`config-networks.ts` maps `NetworkName.EthereumSepolia`).
It needs Node ≥16.20, MongoDB 6, and pm2; there is no Dockerfile, and it
peer-depends on a GitHub fork of ethers (`Railgun-Community/ethers.js#v6.7.10`).

The important constraint: **a POI list is keyed by its provider's public key.** A
node you run serves a list keyed by *your* pubkey, not `efc6ddb5…`. Self-hosting
therefore gives you an *additional* list, not a replacement for the required one
— unless you are also running the Chainalysis screening that the required list
represents. For a wallet to spend, the required list must still be served by
someone who has it.

That is why using the public aggregator is the correct answer here, not a
compromise.

## What is genuinely enforced end-to-end

Verified on Sepolia, with real transactions:

- Real Railgun wallet (0zk address derived from the mnemonic)
- Real shielded balance, tracked against the live merkletree
- Real POI validation via the required Chainalysis list
- Real Groth16 proof (~10s on this hardware)
- Real atomic RelayAdapt transaction
- Real Uniswap V3 swap inside that transaction
- Real reshield of the proceeds

The one property *not* provided today is mempool privacy for the submitting
transaction — see `MEV.md`.
