#!/usr/bin/env bash
# generate_license.sh — obtain machine_id (or accept one), create a per-id folder, generate RSA keys, run mklicense.
#
# Required: --license_type paid|trial
# If --machine_id is omitted, also required: --ip --user --pass --ssh_port
#
# Optional: --feature (default 7), --duration DAYS (if omitted: trial=30, paid=365)
#
# Output layout: <this_dir>/licenses/<machine_id>/<UTC_timestamp>/
#   secrets/server_private_key.pem, secrets/server_public_key.pem, license.lic, info.txt
#
# Requires: built get_remote_machine_id.sh deps, gen_server_keys.sh, mklicense (see mklicense.c header).
# Writes info.txt in the timestamp folder (SSH password is never stored there).
#
# Terminal: exactly one line — "success: <absolute path to license.lic>" or "error: <message>".

set -euo pipefail

fail() {
  local msg="$*"
  msg="${msg//$'\n'/ }"
  msg="${msg//$'\r'/}"
  msg="${msg//  / }"
  echo "error: ${msg}"
  exit 1
}

BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GET_REMOTE="${BIN_DIR}/get_remote_machine_id.sh"
GEN_KEYS="${BIN_DIR}/gen_server_keys.sh"
MKLICENSE="${BIN_DIR}/mklicense"
LICENSE_ROOT="${BIN_DIR}/licenses"

IP=""
USER=""
PASS=""
SSH_PORT=""
LICENSE_TYPE=""
FEATURE="7"
DURATION=""
MACHINE_ID_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ip) IP="${2:-}"; shift 2 ;;
    --user) USER="${2:-}"; shift 2 ;;
    --pass) PASS="${2:-}"; shift 2 ;;
    --ssh_port) SSH_PORT="${2:-}"; shift 2 ;;
    --license_type) LICENSE_TYPE="${2:-}"; shift 2 ;;
    --feature) FEATURE="${2:-}"; shift 2 ;;
    --duration) DURATION="${2:-}"; shift 2 ;;
    --machine_id) MACHINE_ID_ARG="${2:-}"; shift 2 ;;
    -h|--help) fail "invalid arguments (see script header for flags)" ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[[ -n "$LICENSE_TYPE" ]] || fail "--license_type is required (paid or trial)"

LICENSE_TYPE="${LICENSE_TYPE,,}"
[[ "$LICENSE_TYPE" == "paid" || "$LICENSE_TYPE" == "trial" ]] || fail "--license_type must be paid or trial"

if [[ -n "$DURATION" ]]; then
  [[ "$DURATION" =~ ^[0-9]+$ ]] || fail "--duration must be a non-negative integer (days)"
else
  if [[ "$LICENSE_TYPE" == "trial" ]]; then
    DURATION=30
  else
    DURATION=365
  fi
fi

FETCHED_REMOTE=0
if [[ -n "$MACHINE_ID_ARG" ]]; then
  MACHINE_ID="$MACHINE_ID_ARG"
else
  FETCHED_REMOTE=1
  [[ -n "$IP" && -n "$USER" && -n "$PASS" && -n "$SSH_PORT" ]] || fail "without --machine_id, --ip, --user, --pass, and --ssh_port are required"
  [[ -x "$GET_REMOTE" || -f "$GET_REMOTE" ]] || fail "missing get_remote script: ${GET_REMOTE}"
  remote_out=$("$GET_REMOTE" "$IP" "$USER" "$PASS" "$SSH_PORT" 2>/dev/null) || fail "failed to get remote machine id"
  MACHINE_ID="$(printf '%s' "$remote_out" | sed -n 's/^machine_id:[[:space:]]*//p' | tail -n1 | tr -d '\r\n[:space:]')"
fi

MACHINE_ID="$(printf '%s' "$MACHINE_ID" | tr -d '\r\n[:space:]')"
[[ -n "$MACHINE_ID" ]] || fail "empty machine id"
[[ "$MACHINE_ID" != *"/"* && "$MACHINE_ID" != *".."* ]] || fail "machine_id must not contain '/' or '..'"

[[ -f "$MKLICENSE" ]] || fail "missing mklicense binary: ${MKLICENSE}"

MACHINE_DIR="${LICENSE_ROOT}/${MACHINE_ID}"
RUN_STAMP="$(date -u +"%Y-%m-%dT%H%M%SZ")_$$"
WORK_DIR="${MACHINE_DIR}/${RUN_STAMP}"
mkdir -p "$WORK_DIR" || fail "could not create directory: ${WORK_DIR}"

( cd "$WORK_DIR" && "$GEN_KEYS" >/dev/null 2>&1 ) || fail "failed to generate server private/public keys: ${GEN_KEYS}"

PRIV_KEY="${WORK_DIR}/secrets/server_private_key.pem"
PUB_KEY="${WORK_DIR}/secrets/server_public_key.pem"
LICENSE_FILE="${WORK_DIR}/license.lic"

[[ -f "$PRIV_KEY" ]] || fail "private key not created: ${PRIV_KEY}"

"$MKLICENSE" \
  --key "$PRIV_KEY" \
  --out "$LICENSE_FILE" \
  --machine-id "$MACHINE_ID" \
  --duration "$DURATION" \
  --feature "$FEATURE" \
  --license-type "$LICENSE_TYPE" >/dev/null 2>&1 || fail "failed to generate license: ${MKLICENSE}"

INFO_FILE="${WORK_DIR}/info.txt"
GENERATED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
{
  echo "generated_at_utc=${GENERATED_AT}"
  echo "machine_id=${MACHINE_ID}"
  echo "timestamp_folder=${RUN_STAMP}"
  echo "machine_id_directory=${MACHINE_DIR}"
  echo "generation_directory=${WORK_DIR}"
  if [[ "$FETCHED_REMOTE" -eq 1 ]]; then
    echo "machine_id_source=remote (get_remote_machine_id.sh)"
    echo "ssh_ip=${IP}"
    echo "ssh_user=${USER}"
    echo "ssh_port=${SSH_PORT}"
    echo "ssh_password_stored=no (not written to this file)"
  else
    echo "machine_id_source=explicit (--machine_id)"
  fi
  echo "license_type=${LICENSE_TYPE}"
  echo "feature=${FEATURE}"
  echo "duration_days=${DURATION}"
  echo "private_key_path=${PRIV_KEY}"
  echo "public_key_path=${PUB_KEY}"
  echo "license_file_path=${LICENSE_FILE}"
  echo "info_file_path=${INFO_FILE}"
} >"$INFO_FILE" || fail "could not write info.txt: ${INFO_FILE}"

echo "success: ${LICENSE_FILE}"
