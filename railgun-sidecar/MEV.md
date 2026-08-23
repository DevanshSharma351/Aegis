# MEV exposure and submission routing

## What atomicity does and does not buy

The swap executes as one Railgun cross-contract call: unshield → approve →
Uniswap V3 → reshield, all inside a single RelayAdapt transaction.

**Atomicity means** nobody can insert a transaction *between* those steps. There
is no window where the funds sit unshielded and exposed.

**Atomicity does not mean invisibility.** Submitted through the public mempool,
the whole bundle is a pending transaction that anyone can read. A searcher sees
the Uniswap leg it will perform and can front-run and back-run the entire
RelayAdapt call, sandwiching it.

`minimumAmountOut` bounds that loss — a sandwich cannot push execution below the
floor without reverting the swap — but bounding a loss is not preventing it.

## Current default: public

```
AEGIS_SUBMISSION_MODE=public
```

Reported honestly everywhere:

- sidecar log: `broadcasting via 0x975a… over public mempool (PUBLIC MEMPOOL — sandwichable)`
- `/health`: `submission.mempoolExposed: true`
- swap result: `submission.mode: "public"`
- frontend: **SUBMISSION: PUBLIC MEMPOOL**, with the sandwich risk spelled out

## Private submission is available

Flashbots Protect has a Sepolia endpoint, verified reachable:

| Check | Result |
|---|---|
| `https://rpc-sepolia.flashbots.net` | chainId 11155111 |
| `eth_sendRawTransaction` | accepted (RLP error on a malformed probe = parsed and attempted) |
| `eth_sendPrivateTransaction` | present, signature-gated |
| `eth_sendBundle`, `mev_sendBundle` | present, signature-gated |

Enable it:

```bash
AEGIS_SUBMISSION_MODE=private
AEGIS_FLASHBOTS_RELAY_URL=https://rpc-sepolia.flashbots.net
AEGIS_FLASHBOTS_IDENTITY_KEY=0x...   # optional; reputation only, holds no funds
AEGIS_SUBMISSION_FALLBACK=false      # true = retry publicly if it does not land
```

The transaction goes straight to Flashbots builders and never enters the public
mempool, so there is no pending transaction to observe or sandwich.

### Why it is not the default

Inclusion is best-effort. A private transaction lands only if a Flashbots builder
wins the block, and Sepolia builder coverage is far thinner than mainnet. A
default that can silently fail to land is worse than one that is honest about its
exposure — so `public` is the default, and `private` is a deliberate choice.

`AEGIS_SUBMISSION_FALLBACK=true` retries publicly when the private route does not
land within the timeout. When that happens the result reports
`mode: "public"`, so a transaction that ended up in the mempool is never
presented as having been private.

## Execution safeguards, independent of route

These apply on every path, and are the reason a public submission is survivable
rather than reckless:

| Safeguard | Where |
|---|---|
| Slippage floor (`amountOutMinimum`) | `uniswapV3.ts::quoteExactInputSingle`, default 150 bps |
| Token allowlist | `config.ts::resolveAsset` — only `shared/config/assets.json` entries; a symbol or address outside it is a named error |
| Router allowlist | `network.json::uniswapV3.swapRouter02`; the recipe builds calldata for that address only |
| Recipient pinned | swap output must return to RelayAdapt, or the proceeds would be left public |
| Network pinned | `UniswapV3SwapRecipe.supportsNetwork` accepts Sepolia only |
| Post-fee quoting | quote is taken on the amount that survives Railgun's unshield fee, so the floor matches what is actually traded |
| Gas floor | `minGasLimit` prevents a low estimate stranding the recipe mid-flight, which would unshield without reshielding |
| Inner-failure detection | `getRelayAdaptTransactionError` — RelayAdapt returns EVM success even when an inner call fails, so a failed swap is never reported as completed |

## The abstraction

`src/submission.ts` defines `TransactionSubmitter`. `PublicSubmitter` and
`FlashbotsPrivateSubmitter` implement it; `createSubmitter()` picks one from
configuration.

Submission is the **last** step and the only part that varies by route. The
Groth16 proof is generated before it and commits to the exact unshield amounts,
cross-contract calls, and reshield recipients — so no route can alter what was
authorised, and adding a new relay cannot change the semantics of the trade.

Adding another relay means one new class implementing three members. The Railgun
recipe, the proof path, and the sidecar API are untouched.

## What is public even with private submission

Private submission hides the transaction *before* inclusion. Once mined, the
receipt is public like any other. From the real transaction in block 11545787:

```
WETH  RailgunPool -> RelayAdapt   1496250000000000
WETH  SwapRouter  -> UniV3Pool    1494450000000000
USDC  UniV3Pool   -> RelayAdapt        33748856
USDC  RelayAdapt  -> RailgunPool       33664492
```

So for that transaction the amounts and tokens are visible. **What stays hidden
is whose they are** — no 0zk address appears anywhere, and the shielded balance
behind the trade is not revealed or linkable to previous or future operations.

Claiming "amounts are hidden" for a RelayAdapt cross-contract call would be
false: the DEX leg is a public swap by construction. The privacy property is
ownership unlinkability, not amount concealment.

## Measured, not assumed (Sepolia)

Everything below was tested against the live network rather than inferred from
documentation.

**The Flashbots signature was encoded wrong.** Flashbots signs the keccak of the
request body *as a hex string*; this code signed the 32 raw bytes it encodes.
That produces a valid signature over the wrong message, and the relay answers
`-32025 invalid flashbots signature` — which reads like a credentials problem
and is really an encoding one. Private submission could never have worked. Fixed
and verified: signing the bytes returns HTTP 403, signing the hex string returns
HTTP 200.

**Private submission is private on Sepolia, but does not land.** With the
signature fixed, `rpc-sepolia.flashbots.net` accepts the transaction and it is
confirmed absent from the public mempool. No builder ever includes it: a 0-value
self-transfer sent this way was still unmined after 25 blocks / 300s.

**Because Sepolia has no MEV builders.** Sampling 60 consecutive blocks: zero
built by an MEV builder. Every one was vanilla `Nethermind`, `geth`, `besu` or
`erigon`.

**And therefore no searchers.** Checking our own executed swaps: each was the
only swap on its Uniswap pool in its block. Nothing was sandwiched, because
there is nothing on Sepolia to sandwich it.

The conclusion is not "MEV protection is unnecessary" — it is that on this
network private submission trades inclusion for a privacy nobody is attacking.
The same code path on a network with real builder coverage both hides and lands,
which is why the route stays behind configuration rather than being deleted.

## What actually bounds the risk

Three controls, two of them unconditional:

| Control | Active | What it removes |
|---|---|---|
| Atomic RelayAdapt | always | Interleaving. Unshield, swap and reshield are one transaction; nothing can be placed between the legs. |
| On-chain slippage floor | always | Extractable value. Uniswap reverts below `amountOutMinimum`; the pool enforces it, not us. |
| Private submission | configurable | Mempool visibility. Effective where builders exist; on Sepolia it costs inclusion. |

Atomicity is not invisibility, and this file has never claimed otherwise. A
public RelayAdapt call is observable and its swap leg is sandwichable in
principle; the floor caps what that is worth.

## Reporting the outcome instead of asserting protection

"Protected from MEV" is not observable. What a receipt *can* show is measured
after every swap and returned in `execution`:

- `actualBuyAmount` — read from the pool's own Swap event, not the pre-trade quote
- `versusQuoteBps` — realised execution against the quote; negative is the direction a sandwich moves it
- `slippageBudgetUsedPercent` — how much of the floor's headroom was consumed
- `otherSwapsOnPoolInBlock` — zero is positive evidence no sandwich was possible
- `sandwichPatternObserved` — true only when another party traded the same pool **both** before and after ours in the same block

The last one is deliberately strict. "Someone else traded this pool" is ordinary
contention, not an attack, and reporting it as one would cry wolf.
