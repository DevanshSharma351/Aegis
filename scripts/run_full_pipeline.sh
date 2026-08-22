#!/usr/bin/env bash
# =============================================================================
# Aegis — end-to-end pipeline
# =============================================================================
#   enclave /rebalance   decision + TDX quote
#   oracle  /attest      verify the quote, sign the on-chain attestation
#   identity /submit     ERC-4337 UserOperation calling AegisVault.rebalance
#   sidecar  /swap       shielded execution through Railgun
#
# The oracle, identity, and sidecar are on an internal-only Docker network and
# publish no ports. Rather than weakening that by exposing them to the host,
# this script reaches them by running curl *inside* the enclave container, which
# is the one service attached to both networks. If any of these calls could be
# made directly from the host, the isolation would be broken.
#
# Usage:
#   scripts/run_full_pipeline.sh                 # full run
#   scripts/run_full_pipeline.sh --skip-swap     # attestation + on-chain only
#   scripts/run_full_pipeline.sh --dry-run       # stop before anything on-chain
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

SKIP_SWAP=false
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --skip-swap) SKIP_SWAP=true ;;
    --dry-run)   DRY_RUN=true ;;
    -h|--help)   sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# shellcheck disable=SC1091
[ -f .env ] && { set -a; source .env; set +a; }

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
step()  { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$OFF"; }
ok()    { printf '    %s[ok]%s %s\n' "$GREEN" "$OFF" "$1"; }
warn()  { printf '    %s[!]%s  %s\n' "$YELLOW" "$OFF" "$1"; }
die()   { printf '\n%s[FAIL]%s %s\n' "$RED" "$OFF" "$1" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed"; }
need docker
# shellcheck disable=SC1091
source "$SCRIPT_DIR/_common.sh"
PY=$(aegis_find_python) || exit 1

# Run a command inside the enclave container, which sits on the internal
# network. This is the only way the host can address the internal services.
internal() { docker compose exec -T enclave "$@"; }

jqp() { "$PY" -c "import sys,json;d=json.load(sys.stdin);$1"; }

# -----------------------------------------------------------------------------
step "0. Preconditions"
# -----------------------------------------------------------------------------
[ -f shared/config/deployed.json ] || die "shared/config/deployed.json missing. Run scripts/deploy_sepolia.sh first."
[ -f shared/config/session-key-approval.json ] || die "Session key not approved. Run scripts/bootstrap.sh."

DEPLOYED=$(cat shared/config/deployed.json)
VAULT=$(echo "$DEPLOYED" | jqp "print(d['AegisVault'])")
VERIFIER=$(echo "$DEPLOYED" | jqp "print(d['AttestationVerifier'])")
CHAIN_ID=$(echo "$DEPLOYED" | jqp "print(d.get('chainId',11155111))")
EXPECTED_MEASUREMENT=$(echo "$DEPLOYED" | jqp "print(d.get('expectedMeasurement',''))")

ok "vault    $VAULT"
ok "verifier $VERIFIER"
ok "chain    $CHAIN_ID"

# -----------------------------------------------------------------------------
step "1. Bringing up the stack"
# -----------------------------------------------------------------------------
docker compose up -d --wait --wait-timeout 600 dstack-simulator enclave oracle identity \
  || die "docker compose failed to bring up the core services"
ok "dstack-simulator, enclave, oracle, identity are up"

if [ "$SKIP_SWAP" = false ]; then
  docker compose up -d railgun-sidecar || die "failed to start railgun-sidecar"
  ok "railgun-sidecar starting (merkletree scan runs in the background)"
fi

# -----------------------------------------------------------------------------
step "2. Enclave measurement vs. on-chain constant"
# -----------------------------------------------------------------------------
MEASUREMENT_JSON=$(curl -sf -m 60 http://localhost:8000/measurement) \
  || die "enclave /measurement failed — is the guest agent socket mounted?"

LIVE_MEASUREMENT=$(echo "$MEASUREMENT_JSON" | jqp "print(d['measurement'])")
ATTESTATION_SOURCE=$(echo "$MEASUREMENT_JSON" | jqp "print(d['source'])")

ok "enclave measurement $LIVE_MEASUREMENT"
ok "attestation source  $ATTESTATION_SOURCE"

if [ "$ATTESTATION_SOURCE" != "hardware-tdx" ]; then
  warn "Simulator attestation: the quote is not signed by Intel and proves nothing"
  warn "about hardware. Every other check in the chain still runs."
fi

if [ "${LIVE_MEASUREMENT,,}" != "${EXPECTED_MEASUREMENT,,}" ]; then
  die "Measurement mismatch.
      enclave reports : $LIVE_MEASUREMENT
      chain expects   : $EXPECTED_MEASUREMENT
    The enclave image changed since deployment. Either rebuild the image to
    match, or rotate the on-chain constant:
      scripts/rotate_measurement.sh $LIVE_MEASUREMENT"
fi
ok "measurement matches AttestationVerifier.expectedMeasurement"

# -----------------------------------------------------------------------------
step "3. Rebalance decision (data -> signals -> SLM -> TDX quote)"
# -----------------------------------------------------------------------------
echo "    querying CoinGecko, running the model, generating a quote..."
REBALANCE=$(curl -sf -m 600 -X POST http://localhost:8000/rebalance -H 'Content-Type: application/json') \
  || die "enclave /rebalance failed. Logs: docker compose logs enclave"

DECISION_HASH=$(echo "$REBALANCE" | jqp "print(d['attestation']['decision_hash'])")
QUOTE=$(echo "$REBALANCE" | jqp "print(d['attestation']['quote'])")
EVENT_LOG=$(echo "$REBALANCE" | jqp "print(d['attestation']['event_log'])")
SOURCE=$(echo "$REBALANCE" | jqp "print(d['attestation']['source'])")

echo "$REBALANCE" | jqp "
print('    allocation :', ', '.join(f'{k} {v:.1%}' for k,v in d['allocation'].items()))
print('    rationale  :', d['rationale'][:100])
print('    confidence :', d['confidence'])
"
ok "decision hash $DECISION_HASH"
ok "quote $(( (${#QUOTE} - 2) / 2 )) bytes"

if [ "$DRY_RUN" = true ]; then
  step "Dry run — stopping before anything touches the chain"
  exit 0
fi

# -----------------------------------------------------------------------------
step "4. Oracle verification and signing"
# -----------------------------------------------------------------------------
ORACLE_REQUEST=$("$PY" -c "
import json, sys
print(json.dumps({
    'quote': sys.argv[1],
    'decision_hash': sys.argv[2],
    'event_log': sys.argv[3],
    'source': sys.argv[4],
    'verifier_address': sys.argv[5],
    'chain_id': int(sys.argv[6]),
}))" "$QUOTE" "$DECISION_HASH" "$EVENT_LOG" "$SOURCE" "$VERIFIER" "$CHAIN_ID")

ORACLE_RESPONSE=$(printf '%s' "$ORACLE_REQUEST" | internal curl -sf -m 120 \
    -X POST http://oracle:8100/attest \
    -H 'Content-Type: application/json' --data-binary @-) \
  || die "oracle rejected the attestation. Logs: docker compose logs oracle"

echo "$ORACLE_RESPONSE" | jqp "
for c in d['checksPerformed']:
    print('    -', c)
"
PROOF=$(echo "$ORACLE_RESPONSE" | jqp "print(d['proof'])")
ORACLE_MEASUREMENT=$(echo "$ORACLE_RESPONSE" | jqp "print(d['measurement'])")
EXPIRY=$(echo "$ORACLE_RESPONSE" | jqp "print(d['expiry'])")

[ "${ORACLE_MEASUREMENT,,}" = "${LIVE_MEASUREMENT,,}" ] \
  || die "oracle derived $ORACLE_MEASUREMENT from the quote but the enclave reported $LIVE_MEASUREMENT"

ok "oracle signed; proof $(( (${#PROOF} - 2) / 2 )) bytes, expires at $EXPIRY"

# -----------------------------------------------------------------------------
step "5. On-chain: AegisVault.rebalance via ERC-4337"
# -----------------------------------------------------------------------------
SUBMIT_REQUEST=$("$PY" -c "
import json, sys
print(json.dumps({'decisionHash': sys.argv[1], 'attestationProof': sys.argv[2]}))
" "$DECISION_HASH" "$PROOF")

SUBMIT_RESPONSE=$(printf '%s' "$SUBMIT_REQUEST" | internal curl -s -m 300 \
    -X POST http://identity:8200/submit-rebalance \
    -H 'Content-Type: application/json' --data-binary @-)

SUBMIT_OK=$(echo "$SUBMIT_RESPONSE" | jqp "print(d.get('success', False))")
if [ "$SUBMIT_OK" != "True" ]; then
  echo "$SUBMIT_RESPONSE" | jqp "print('    error:', d.get('error','unknown'))"
  die "UserOperation submission failed"
fi

TX_HASH=$(echo "$SUBMIT_RESPONSE" | jqp "print(d['txHash'])")
SEQUENCE=$(echo "$SUBMIT_RESPONSE" | jqp "print(d['sequence'])")
BLOCK=$(echo "$SUBMIT_RESPONSE" | jqp "print(d['blockNumber'])")
VAULT_TX_URL=$(echo "$SUBMIT_RESPONSE" | jqp "print(d['explorerUrl'])")

ok "RebalanceExecuted #$SEQUENCE in block $BLOCK"
ok "tx $TX_HASH"

# -----------------------------------------------------------------------------
step "6. Shielded execution"
# -----------------------------------------------------------------------------
SWAP_TX=""
SWAP_URL=""

if [ "$SKIP_SWAP" = true ]; then
  warn "skipped (--skip-swap)"
else
  SIDECAR_HEALTH=$(internal curl -s -m 20 http://railgun-sidecar:8080/health || echo '{}')
  SWAP_CAPABLE=$(echo "$SIDECAR_HEALTH" | jqp "print(d.get('capabilities',{}).get('unshieldSwapReshield', False))" 2>/dev/null || echo False)

  if [ "$SWAP_CAPABLE" != "True" ]; then
    warn "sidecar cannot execute a shielded swap right now:"
    echo "$SIDECAR_HEALTH" | jqp "print('      engineReady=%s poiConfigured=%s' % (d.get('engineReady'), d.get('poiConfigured')))" 2>/dev/null || true
    warn "Spending shielded funds needs RAILGUN_POI_NODE_URL. See railgun-sidecar/README.md."
  else
    SELL_AMOUNT="${AEGIS_SWAP_SELL_AMOUNT:-1000000000000000}"  # 0.001 WETH
    echo "    unshield -> Uniswap V3 swap -> reshield (proof takes 1-3 minutes)"

    SWAP_REQUEST=$("$PY" -c "
import json, sys
print(json.dumps({'sellToken':'WETH','buyToken':'USDC','sellAmount':sys.argv[1],'slippageBps':100}))
" "$SELL_AMOUNT")

    SWAP_RESPONSE=$(printf '%s' "$SWAP_REQUEST" | internal curl -s -m 900 \
        -X POST http://railgun-sidecar:8080/unshield-swap-reshield \
        -H 'Content-Type: application/json' --data-binary @-)

    SWAP_OK=$(echo "$SWAP_RESPONSE" | jqp "print(d.get('success', False))" 2>/dev/null || echo False)
    if [ "$SWAP_OK" = "True" ]; then
      SWAP_TX=$(echo "$SWAP_RESPONSE" | jqp "print(d['txHash'])")
      SWAP_URL=$(echo "$SWAP_RESPONSE" | jqp "print(d['explorerUrl'])")
      echo "$SWAP_RESPONSE" | jqp "
print('    sold      :', d['sellAmount'], d['sellSymbol'])
print('    quoted    :', d['quotedBuyAmount'], d['buySymbol'], '(fee tier %d)' % d['feeTier'])
print('    proof     : %.1fs' % (d['proofDurationMs']/1000))
"
      ok "shielded swap $SWAP_TX"
    else
      echo "$SWAP_RESPONSE" | jqp "print('      error:', d.get('error','unknown'))" 2>/dev/null || echo "$SWAP_RESPONSE"
      warn "shielded swap did not execute; the on-chain attestation above still stands"
    fi
  fi
fi

# -----------------------------------------------------------------------------
step "Summary"
# -----------------------------------------------------------------------------
cat <<SUMMARY

  Attestation      PASS (verified on-chain)
  Source           $ATTESTATION_SOURCE
  Measurement      $LIVE_MEASUREMENT
  Decision hash    $DECISION_HASH
  Vault log        #$SEQUENCE, block $BLOCK
  Vault tx         $VAULT_TX_URL
SUMMARY

if [ -n "$SWAP_TX" ]; then
  echo "  Shielded swap    $SWAP_URL"
  echo ""
  echo "  On Etherscan the swap appears as an interaction with the Railgun"
  echo "  RelayAdapt contract. The token amounts and the 0zk owner are not"
  echo "  visible, and the vault's event log carries only a hash and a timestamp."
else
  echo "  Shielded swap    not executed"
fi
echo ""
