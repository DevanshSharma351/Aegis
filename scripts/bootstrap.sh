#!/usr/bin/env bash
# =============================================================================
# Aegis — one-time bootstrap
# =============================================================================
# Resolves the circular dependency between AegisVault and the session key.
#
#   AegisVault needs the executing account's address to enforce policy.
#   The session key's policy needs the vault's address to scope itself.
#
# Neither can be created knowing the other, so the sequence is:
#
#   1. Deploy the vault with sessionKey unset          (deploy_sepolia.sh)
#   2. Derive the ERC-4337 smart account address       — counterfactual, needs
#                                                        no transaction
#   3. Build the session-key approval scoped to the vault
#   4. Bind the SMART ACCOUNT to the vault             — one-shot, irreversible
#
# Step 4 binds the smart account, not the session-key EOA. A UserOperation
# executes with msg.sender == account, so binding the EOA yields a vault that
# reverts NotSessionKey() forever — and because setSessionKey is one-shot, that
# is unrecoverable without a redeploy.
#
#   scripts/bootstrap.sh            # prompts before the irreversible step
#   scripts/bootstrap.sh --yes      # non-interactive
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
[ -f .env ] && { set -a; source .env; set +a; }

# shellcheck disable=SC1091
source "$SCRIPT_DIR/_common.sh"
PY=$(aegis_find_python) || exit 1

AUTO_YES=""
[ "${1:-}" = "--yes" ] && AUTO_YES="--yes"

BOLD=$'\033[1m'; RED=$'\033[31m'; OFF=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$OFF"; }
die()  { printf '\n%s[FAIL]%s %s\n' "$RED" "$OFF" "$1" >&2; exit 1; }

: "${AEGIS_OWNER_PRIVATE_KEY:?set AEGIS_OWNER_PRIVATE_KEY in .env}"
: "${SESSION_KEY_PRIVATE_KEY:?set SESSION_KEY_PRIVATE_KEY in .env}"
: "${PIMLICO_API_KEY:?set PIMLICO_API_KEY in .env}"

[ -f shared/config/deployed.json ] || die "deployed.json missing. Run scripts/deploy_sepolia.sh first."

cd identity
[ -d node_modules ] || { echo "installing identity dependencies..."; npm install --no-audit --no-fund; }

step "1. Smart account address"
npx tsx src/createAccount.ts || die "could not derive the smart account address"

step "2. Session-key approval"
# Produces an enable signature scoped to (vault, rebalance selector, zero value,
# 1/day). The blob is not a secret: without SESSION_KEY_PRIVATE_KEY it
# authorises nothing.
npx tsx src/approveSessionKey.ts || die "approval failed"

step "3. Binding the account to the vault (IRREVERSIBLE)"
# shellcheck disable=SC2086
npx tsx src/setVaultSessionKey.ts $AUTO_YES || die "binding failed"

cd "$ROOT_DIR"

step "4. Verifying"
(cd identity && npx tsx src/printState.ts) 2>/dev/null \
  | "$PY" -c "
import sys, json
d = json.load(sys.stdin)
c = d['checks']
print('  smart account   :', d['smartAccount'])
print('  vault sessionKey:', d['vault']['sessionKey'])
print('  bound correctly :', c['sessionKeyMatchesSmartAccount'])
if not c['sessionKeyMatchesSmartAccount']:
    raise SystemExit('BOUND ADDRESS DOES NOT MATCH THE SMART ACCOUNT')
" || die "post-bootstrap verification failed"

cat <<'NEXT'

  Bootstrap complete.

    scripts/verify_deployment.sh     full sanity check
    scripts/run_full_pipeline.sh     end-to-end run

NEXT
