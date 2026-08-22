# Railgun sidecar

Private execution for Aegis: moves value into Railgun's shielded pool and swaps
inside it, so the agent's positions are not visible on-chain.

## What it does

| Endpoint | Method | What actually happens |
|---|---|---|
| `/health` | GET | Engine state plus a per-capability breakdown |
| `/wallet` | GET | 0zk address, submitter EOA, whitelisted assets |
| `/balances` | GET | Shielded balances, split into total and spendable |
| `/shield` | POST | Approve + shield an ERC-20 into the 0zk wallet |
| `/unshield-swap-reshield` | POST | One transaction: unshield → Uniswap V3 → reshield |

## The two identities

They are easy to conflate and do entirely different things.

**The 0zk wallet** holds the shielded balance. It has no on-chain presence and
no address anyone can look up. It spends by producing a Groth16 proof, not by
signing a transaction. Derived from `RAILGUN_WALLET_MNEMONIC`.

**The submitter** is an ordinary EOA that broadcasts transactions and pays gas.
It learns nothing about the balances it is broadcasting for — it holds the
proof, not the secrets behind it. Set by `RAILGUN_TEST_SIGNER_KEY`.

## Proof of Innocence — read this before expecting a swap to work

Sepolia is configured as a POI-required network in `@railgun-community/wallet`.
That produces a sharp split in what works without a POI aggregator node:

| Operation | Without `RAILGUN_POI_NODE_URL` |
|---|---|
| Start the engine, load the provider | works |
| Scan the merkletree, read balances | works |
| Shield | works |
| Unshield / swap / reshield | **fails** |

The reason is that `WalletPOI.init` performs no network I/O — it registers the
node interface and returns — so `loadProvider` is satisfied by any URL. Actual
POI requests happen only when *spending*, where generating a transact proof
requires POI merkle proofs from a live aggregator.

The sidecar checks this up front and returns HTTP 501 with an explanation,
rather than letting you wait several minutes for proof generation to die on an
opaque request error.

To enable spending, set `RAILGUN_POI_NODE_URL` to a reachable POI aggregator.
At the time of writing, no public Sepolia aggregator was reachable from this
environment; the operator has to supply one, or run
`startRailgunEngineForPOINode` themselves.

## Why the swap is hand-built

Cookbook ships no swap adapter that works on Sepolia:

- `ZeroXSwapRecipe` targets `https://sepolia.api.0x.org/swap/v1/quote` — the
  per-chain subdomain form of the retired 0x v1 API.
- `ZeroXV2SwapRecipe` requires a paid 0x API key.
- The UniV2-like recipes `throw` explicitly for `EthereumSepolia`, in both
  `getFactoryAddressAndInitCodeHash` and `getRouterContractAddress`.

Uniswap V3, meanwhile, is deployed on Sepolia with real liquidity in exactly the
pair the asset whitelist names. Measured against the live chain:

```
WETH/USDC 0.05% pool   144 WETH / 3.04M USDC
QuoterV2               0.001 WETH -> 21.85 USDC
```

So `src/recipes.ts` defines two custom Cookbook `Step`s — an approval and a
`SwapRouter02.exactInputSingle` — and composes them into a `Recipe`. Cookbook
wraps that with its own unshield and shield steps, and the whole thing executes
through Railgun's RelayAdapt as one cross-contract call.

## The three-call sequence, and why the order is fixed

```
gasEstimateForUnprovenCrossContractCalls   price it with a dummy proof
generateCrossContractCallsProof            the real Groth16 proof (1-3 min)
populateProvedCrossContractCalls           wrap it into a broadcastable tx
```

The proof commits to the gas parameters, so estimation must come first. It also
commits to the exact unshield amounts, cross-contract calls, and reshield
recipients — which is what makes it safe for a public EOA to broadcast a
transaction spending funds it cannot see. Nothing between step 2 and step 3 can
be altered without invalidating the proof.

## Running it

The sidecar is on an internal-only Docker network with no published ports,
because it holds the mnemonic. Reach it through a container that shares that
network:

```bash
docker compose exec -T enclave curl -s http://railgun-sidecar:8080/health
```

Shield some WETH (amounts are always base-unit integers):

```bash
docker compose exec -T enclave curl -s -X POST http://railgun-sidecar:8080/shield \
  -H 'Content-Type: application/json' \
  -d '{"token":"WETH","amount":"1000000000000000"}'
```

Swap inside the pool:

```bash
docker compose exec -T enclave curl -s -X POST http://railgun-sidecar:8080/unshield-swap-reshield \
  -H 'Content-Type: application/json' \
  -d '{"sellToken":"WETH","buyToken":"USDC","sellAmount":"1000000000000000","slippageBps":100}'
```

Get WETH in the first place — Sepolia WETH has a `deposit()` function, so no
faucet is needed:

```bash
cd railgun-sidecar
npm run fund -- wrap 0.02
npm run fund -- balances
```

## Operational notes

**Engine state is worth keeping.** A cold merkletree scan takes ~45s; a warm one
takes ~6s. The `railgun-data` volume holds both that state and the downloaded
Groth16 artifacts, which are tens of megabytes.

**LevelDB is single-writer.** Two sidecar processes against one database
directory produce `IO error: LockFile ... being used by another process`. Run
one.

**Total vs. spendable balances differ.** A freshly shielded note enters the tree
immediately but is not spendable until POI validation completes. `/balances`
reports both, because "I have the balance but the spend fails" otherwise looks
like a bug.

**RelayAdapt swallows inner failures.** A failed swap still produces a
successful transaction at the EVM level, with the reason encoded in a log. The
sidecar calls `getRelayAdaptTransactionError` and raises on it — the funds are
safely re-shielded either way, but reporting a failed swap as a completed one
would be false.

## The seam for Workstream B

`getSubmitter()` in `src/wallet.ts` is the single function that would change to
route broadcasts through the ERC-4337 session-key account.

It has deliberately **not** been changed. The session key is currently scoped to
one selector on one contract, and that contract has no function that can move a
token. Letting it also call RelayAdapt widens it from "can write to the
execution log" to "can move shielded funds" — the single largest authority
increase available anywhere in this system. That should be a deliberate,
separately reviewed change, not a side effect of wiring the pipeline together.
