#!/usr/bin/env bash
# get_remote_machine_id.sh — verify SSH first, then copy local machine_id binary, run on remote, print output, remove remote copy.
#
# Usage: ./get_remote_machine_id.sh <ip> <user> <pass> <ssh_port>
#
# Requires: sshpass (apt: sshpass), OpenSSH client, and a built ./machine_id next to this script:
#   gcc -O2 -Wall -Wextra -o machine_id machine_id.c -lcrypto

set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "Usage: $0 <ip> <user> <pass> <ssh_port>" >&2
  exit 1
fi

IP="$1"
USER="$2"
PASS="$3"
SSH_PORT="$4"

if ! command -v sshpass >/dev/null 2>&1; then
  echo "error: sshpass not found (install e.g. apt install sshpass)" >&2
  exit 1
fi

SSH_COMMON_OPTS=(
  -o "StrictHostKeyChecking=no"
  -o "UserKnownHostsFile=/dev/null"
  -o "LogLevel=ERROR"
  -o "ConnectTimeout=3"
)

ssh_test_out=""
if ! ssh_test_out=$(
  sshpass -p "${PASS}" ssh "${SSH_COMMON_OPTS[@]}" -p "${SSH_PORT}" "${USER}@${IP}" "exit 0" 2>&1
); then
  echo "error: SSH test failed for ${USER}@${IP} port ${SSH_PORT} (cannot connect or authenticate)." >&2
  #if [[ -n "${ssh_test_out}" ]]; then
  #  echo "${ssh_test_out}" >&2
  #fi
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_BIN="${SCRIPT_DIR}/machine_id"

if [[ ! -f "$LOCAL_BIN" ]]; then
  echo "error: missing ${LOCAL_BIN} — build from machine_id.c:" >&2
  echo "  gcc -O2 -Wall -Wextra -o \"${SCRIPT_DIR}/machine_id\" \"${SCRIPT_DIR}/machine_id.c\" -lcrypto" >&2
  exit 1
fi

REMOTE_PATH="/tmp/machine_id_$$_${RANDOM}"

cleanup() {
  sshpass -p "${PASS}" ssh "${SSH_COMMON_OPTS[@]}" -p "${SSH_PORT}" "${USER}@${IP}" "rm -f -- '${REMOTE_PATH}'" 2>/dev/null || true
}
trap cleanup EXIT

sshpass -p "${PASS}" scp "${SSH_COMMON_OPTS[@]}" -P "${SSH_PORT}" "${LOCAL_BIN}" "${USER}@${IP}:${REMOTE_PATH}"
#sshpass -p "${PASS}" ssh "${SSH_COMMON_OPTS[@]}" -p "${SSH_PORT}" "${USER}@${IP}" "chmod +x -- '${REMOTE_PATH}' && exec '${REMOTE_PATH}'"

machine_id=$(sshpass -p "${PASS}" ssh "${SSH_COMMON_OPTS[@]}" -p "${SSH_PORT}" "${USER}@${IP}" "exec '${REMOTE_PATH}'")
echo "machine_id: ${machine_id}"

cleanup
exit 0