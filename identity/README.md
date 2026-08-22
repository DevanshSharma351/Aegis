# Identity — ERC-4337 account and session key

Owns the smart account that submits rebalances, and the session key scoped to do
nothing else.

## The one thing to get right

`AegisVault.sessionKey` must hold the **smart account** address, not the
session-key EOA.

A UserOperation executes with `msg.sender == account`. The EOA that signs it
never appears as the caller. Bind the EOA and every rebalance reverts
`NotSessionKey()` — permanently, because `setSessionKey` is one-shot.

```
owner EOA          0x975a…c40   signs the approval, never used at runtime
session key EOA    0x4713…D63   signs UserOperations, never msg.sender
smart account      0x61e7…662   IS msg.sender   <- this is what the vault binds
```

## Approve once, execute forever

A ZeroDev permission validator must be *enabled* on the Kernel account, and
enabling it needs a signature from the owner's sudo validator. There are two ways
to arrange that:

**(a)** Attach `{ sudo: ownerValidator, regular: permissionValidator }` on every
submission. The owner key is then present at every signing — so the session key
provides no isolation at all.

**(b)** Do it once. Build the account with both plugins, serialise it (the blob
carries the owner's enable signature), and store it. Afterwards, load the blob
with only the session-key signer.

This service implements (b). `approveSessionKey.ts` runs once with the owner
online; `submitUserOp.ts` runs on every rebalance and never reads
`AEGIS_OWNER_PRIVATE_KEY`. The compose file does not pass the owner key into the
container at all.

The approval blob (`shared/config/session-key-approval.json`) is not a secret —
it is an enable signature scoped to one permission id. Without the session key's
private key it authorises nothing.

## Bootstrap

```bash
npm run account              # 1. derive the counterfactual account address
npm run session-key:approve  # 2. build the approval, scoped to the vault
npm run session-key:bind     # 3. setSessionKey(smartAccount) — IRREVERSIBLE
npm run state                # 4. verify
```

`scripts/bootstrap.sh` runs all four with the checks in between.

Step 3 simulates before sending and reads the value back afterwards. This is the
one write in the system that cannot be retried, so it is worth the extra call.

## The policy

From `shared/config/policy.json`, enforced on-chain by the Kernel permission
module during `validateUserOp`:

| Constraint | Value |
|---|---|
| target | `AegisVault` only |
| selector | `rebalance(bytes32,bytes)` = `0xe7ef57de` |
| value limit | 0 wei |
| rate limit | 1 per 86400s |

`assertPolicyMatchesAbi()` compares the declared selector against the compiled
ABI at startup. The policy file previously declared `0x7f1a1e28` — a selector for
no function that exists — and nothing caught it, because nothing compared the
two.

## HTTP API

Internal network only.

| Endpoint | Purpose |
|---|---|
| `GET /health` | liveness: chain id, block, plus `sessionKeyReady` |
| `GET /state` | full on-chain view with consistency checks |
| `POST /submit-rebalance` | `{ decisionHash, attestationProof }` |

`/health` deliberately returns 200 before the bootstrap has run, reporting
`sessionKeyReady: false`. Failing liveness on a missing approval would deadlock
`docker compose up --wait`, since the bootstrap needs the stack already running.

`/submit-rebalance` pre-flights before signing: it confirms the vault is bound to
this account and that the decision has not already been executed. A
UserOperation that reverts on-chain still costs the paymaster gas and produces a
far less legible error than a local check. It returns 409 for an
already-executed decision — a distinct, expected outcome the orchestrator
reports rather than retries.

## Session key storage

`SESSION_KEY_PRIVATE_KEY` is a plaintext environment variable. That is the known
gap.

The production path is derivation inside the TEE via `DstackClient.get_key`, so
the key exists only in enclave memory and is reproducible from the enclave's
identity — meaning a different enclave build derives a different key and cannot
inherit this one's authority. See the comment on `sessionKeyAccount()` in
`src/clients.ts`.

The blast radius is bounded by design rather than by this secret: the key can
call one function, with zero value, once a day, on a contract with no way to
move funds. A leak lets someone write junk to the execution log. It does not let
them take anything.
