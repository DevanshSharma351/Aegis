#!/usr/bin/env bash
# =============================================================================
# Aegis — deployment sanity checks
# =============================================================================
# Every check here corresponds to a way the deployment can be subtly wrong while
# each individual component looks healthy. They are the questions worth asking
# before trusting a run:
#
#   1. Is the vault bound to the account that will actually be msg.sender?
#      (Binding the session-key EOA instead of the smart account produces a
#      vault that reverts forever, and the setter is one-shot.)
#   2. Does the running enclave's measurement match the on-chain constant?
#   3. Is the oracle the chain trusts the oracle that is running?
#   4. Is the Railgun sidecar genuinely unreachable from the host?
#   5. Does deployed.json still describe what is actually on-chain?
#
# Exit code is non-zero if any check fails.
# =============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
[ -f .env ] && { set -a; source .env; set +a; }

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
FAILURES=0
# shellcheck disable=SC1091
source "$SCRIPT_DIR/_common.sh"
PY=$(aegis_find_python) || exit 1

pass() { printf '  %s[PASS]%s %s\n' "$GREEN" "$OFF" "$1"; }
fail() { printf '  %s[FAIL]%s %s\n' "$RED" "$OFF" "$1"; FAILURES=$((FAILURES + 1)); }
warn() { printf '  %s[WARN]%s %s\n' "$YELLOW" "$OFF" "$1"; }
head2() { printf '\n%s%s%s\n' "$BOLD" "$1" "$OFF"; }

jqp() { "$PY" -c "import sys,json;d=json.load(sys.stdin);$1"; }

printf '%s=== Aegis deployment verification ===%s\n' "$BOLD" "$OFF"

# -----------------------------------------------------------------------------
head2 "Config files"
# -----------------------------------------------------------------------------
for f in shared/config/deployed.json shared/config/assets.json \
         shared/config/policy.json shared/config/network.json \
         shared/abi/AegisVault.json shared/abi/AttestationVerifier.json; do
  if [ ! -f "$f" ]; then
    fail "$f is missing"
  elif ! "$PY" -c "import json,sys; json.load(open(sys.argv[1],encoding='utf-8-sig'))" "$f" 2>/dev/null; then
    fail "$f is not valid JSON"
  else
    pass "$f"
  fi
done

[ "$FAILURES" -gt 0 ] && { printf '\n%sConfig is broken; skipping the remaining checks.%s\n' "$RED" "$OFF"; exit 1; }

DEPLOYED=$(cat shared/config/deployed.json)
VAULT=$(echo "$DEPLOYED" | jqp "print(d.get('AegisVault',''))")
VERIFIER=$(echo "$DEPLOYED" | jqp "print(d.get('AttestationVerifier',''))")
EXPECTED_MEASUREMENT=$(echo "$DEPLOYED" | jqp "print(d.get('expectedMeasurement',''))")

# -----------------------------------------------------------------------------
head2 "Policy vs. compiled ABI"
# -----------------------------------------------------------------------------
# The policy file previously declared selector 0x7f1a1e28 for a function whose
# real selector is 0xe7ef57de, and nothing compared them.
SELECTOR_CHECK=$("$PY" - <<'PYEOF'
import json
policy = json.load(open("shared/config/policy.json", encoding="utf-8-sig"))
abi = json.load(open("shared/abi/AegisVault.json", encoding="utf-8-sig"))

declared = policy["sessionKeyPolicy"]["allowedSelectors"][0]
sig = declared["signature"]

fn = next((e for e in abi if e.get("type") == "function" and e["name"] == "rebalance"), None)
if fn is None:
    print("FAIL|AegisVault ABI has no rebalance function")
else:
    actual_sig = "rebalance(" + ",".join(i["type"] for i in fn["inputs"]) + ")"
    if actual_sig != sig:
        print(f"FAIL|policy signature {sig} != ABI {actual_sig}")
    else:
        print(f"OK|{sig}")
PYEOF
)
if [[ "$SELECTOR_CHECK" == OK\|* ]]; then
  pass "policy selector matches the compiled ABI (${SELECTOR_CHECK#OK|})"
else
  fail "${SELECTOR_CHECK#FAIL|}"
fi

if [ "$(echo "$DEPLOYED" | jqp "print(d.get('expectedMeasurement','0x0'))")" = "0x0000000000000000000000000000000000000000000000000000000000000000" ]; then
  fail "deployed.json records a zero measurement; the verifier would accept nothing"
else
  pass "deployed.json records a non-zero measurement"
fi

# -----------------------------------------------------------------------------
head2 "On-chain state"
# -----------------------------------------------------------------------------
# Delegated to identity/src/printState.ts rather than reimplemented in cast:
# one implementation of the reads, one ABI, one set of comparisons.
if docker compose ps --status running --services 2>/dev/null | grep -q '^identity$'; then
  STATE=$(docker compose exec -T identity npx tsx src/printState.ts 2>/dev/null)
else
  STATE=$(cd identity && npx tsx src/printState.ts 2>/dev/null)
fi

if [ -z "$STATE" ]; then
  fail "could not read on-chain state (identity service and local tsx both failed)"
else
  eval "$(echo "$STATE" | "$PY" -c "
import sys, json
d = json.load(sys.stdin)
c = d['checks']
for k, v in c.items():
    print(f'CHECK_{k}={v}')
print('SMART_ACCOUNT=' + str(d.get('smartAccount')))
print('VAULT_SESSION_KEY=' + d['vault']['sessionKey'])
print('CHAIN_MEASUREMENT=' + d['verifier']['expectedMeasurement'])
print('ORACLE_SIGNER=' + d['verifier']['oracleSigner'])
print('REBALANCE_COUNT=' + d['vault']['rebalanceCount'])
")"

  [ "$CHECK_sessionKeyBound" = "True" ] \
    && pass "vault has a session key bound" \
    || fail "vault has no session key bound — run scripts/bootstrap.sh"

  if [ "$CHECK_sessionKeyMatchesSmartAccount" = "True" ]; then
    pass "bound key is the ERC-4337 smart account ($VAULT_SESSION_KEY)"
  else
    fail "vault is bound to $VAULT_SESSION_KEY but the approval yields $SMART_ACCOUNT.
         Every rebalance will revert with NotSessionKey(). setSessionKey is
         one-shot, so this requires redeploying the contracts."
  fi

  [ "$CHECK_vaultPointsAtVerifier" = "True" ] \
    && pass "vault points at the deployed verifier" \
    || fail "vault's attestationVerifier does not match deployed.json"

  [ "$CHECK_deployedJsonMatchesChain" = "True" ] \
    && pass "deployed.json addresses match the chain" \
    || fail "deployed.json addresses do not match what is deployed"

  [ "$CHECK_oracleMatchesDeployedJson" = "True" ] \
    && pass "oracle signer matches deployed.json ($ORACLE_SIGNER)" \
    || fail "verifier's oracleSigner is $ORACLE_SIGNER, not what deployed.json records"

  [ "$CHECK_measurementMatchesDeployedJson" = "True" ] \
    && pass "on-chain measurement matches deployed.json" \
    || fail "on-chain measurement $CHAIN_MEASUREMENT != deployed.json $EXPECTED_MEASUREMENT"

  pass "rebalances recorded so far: $REBALANCE_COUNT"
fi

# -----------------------------------------------------------------------------
head2 "Live enclave measurement"
# -----------------------------------------------------------------------------
if MEAS=$(curl -sf -m 30 http://localhost:8000/measurement 2>/dev/null); then
  LIVE=$(echo "$MEAS" | jqp "print(d['measurement'])")
  SRC=$(echo "$MEAS" | jqp "print(d['source'])")

  if [ "${LIVE,,}" = "${EXPECTED_MEASUREMENT,,}" ]; then
    pass "running enclave matches the on-chain measurement"
  else
    fail "enclave reports $LIVE but the chain expects $EXPECTED_MEASUREMENT
         The image changed since deployment. Rebuild it, or rotate the constant."
  fi

  if [ "$SRC" = "hardware-tdx" ]; then
    pass "attestation source: hardware-tdx"
  else
    warn "attestation source: $SRC — quotes are not Intel-signed and prove nothing about hardware"
  fi
else
  warn "enclave not reachable on :8000; skipped the live measurement check"
fi

# -----------------------------------------------------------------------------
head2 "Oracle identity"
# -----------------------------------------------------------------------------
if ORACLE_HEALTH=$(docker compose exec -T enclave curl -sf -m 15 http://oracle:8100/health 2>/dev/null); then
  RUNNING_SIGNER=$(echo "$ORACLE_HEALTH" | jqp "print(d['oracleSigner'])")
  REQUIRE_HW=$(echo "$ORACLE_HEALTH" | jqp "print(d['requireHardware'])")
  ALLOWLIST=$(echo "$ORACLE_HEALTH" | jqp "print(d['allowlistSize'])")

  if [ "${RUNNING_SIGNER,,}" = "${ORACLE_SIGNER,,}" ]; then
    pass "running oracle key matches the on-chain oracleSigner"
  else
    fail "oracle is running as $RUNNING_SIGNER but the verifier trusts $ORACLE_SIGNER.
         Every proof it signs would be rejected on-chain."
  fi

  [ "$ALLOWLIST" = "0" ] \
    && warn "oracle has no measurement allowlist — it will sign for any enclave build" \
    || pass "oracle allowlist holds $ALLOWLIST measurement(s)"

  [ "$REQUIRE_HW" = "True" ] \
    && pass "oracle requires hardware attestation" \
    || warn "oracle accepts simulator attestations (AEGIS_REQUIRE_HARDWARE unset)"
else
  warn "oracle not reachable; skipped the oracle identity check"
fi

# -----------------------------------------------------------------------------
head2 "Network isolation"
# -----------------------------------------------------------------------------
# The sidecar holds the mnemonic controlling the shielded balance. It must be
# reachable from the enclave and from nowhere else.
if curl -sf -m 4 http://localhost:8080/health >/dev/null 2>&1; then
  fail "railgun-sidecar answered on localhost:8080 — it must not be exposed to the host.
       Check for a 'ports:' mapping in docker-compose.yml."
else
  pass "railgun-sidecar is not reachable from the host"
fi

if curl -sf -m 4 http://localhost:8100/health >/dev/null 2>&1; then
  fail "oracle answered on localhost:8100 — the signing key must not be host-reachable"
else
  pass "oracle is not reachable from the host"
fi

if curl -sf -m 4 http://localhost:8200/health >/dev/null 2>&1; then
  fail "identity answered on localhost:8200 — the session key must not be host-reachable"
else
  pass "identity is not reachable from the host"
fi

if docker compose ps --status running --services 2>/dev/null | grep -q '^railgun-sidecar$'; then
  if docker compose exec -T enclave curl -sf -m 15 http://railgun-sidecar:8080/health >/dev/null 2>&1; then
    pass "railgun-sidecar IS reachable from the enclave (isolation is scoped, not total)"
  else
    warn "railgun-sidecar not answering from inside the network yet (it may still be scanning)"
  fi
fi

# -----------------------------------------------------------------------------
printf '\n%s' "$BOLD"
if [ "$FAILURES" -eq 0 ]; then
  printf '%sAll checks passed.%s\n\n' "$GREEN" "$OFF"
  exit 0
fi
printf '%s%d check(s) failed.%s\n\n' "$RED" "$FAILURES" "$OFF"
exit 1
