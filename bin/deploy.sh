#!/usr/bin/env bash
# Run on the target server from the directory that contains the uploaded artifacts
# (license.tar.gz, deploy.sh, dbip-full-2026-02.mmdb.tar.gz, dorian-ddos-firewall-*.tar.gz).
#
# Usage:
#   ./deploy.sh [--all | --license-only | --version-only]
#
# Default: --all
#   --all            Extract dorian, license, GeoIP; then angelos venv + systemd units
#   --license-only   Extract only license.tar.gz to /usr/local/share/dorian/
#                    (no GeoIP, no dorian tarball, no venv, no systemd — extract only)
#   --version-only   Extract only dorian-ddos-firewall-*.tar.gz; then venv + systemd units
#
# Targets:
#   dorian-ddos-firewall-*.tar.gz  -> /usr/local/share/dorian/
#   license.tar.gz                 -> /usr/local/share/dorian/
#   dbip-full-2026-02.mmdb.tar.gz  -> /usr/local/share/dorian/athens/nginx/lua/geoip2
#
# After a dorian payload extract (--all or --version-only):
#   - Python venv under /usr/local/share/dorian/angelos/venv + pip install -r requirements.txt
#   - Install systemd units to /etc/systemd/system/, daemon-reload, enable --now:
#       angelos.service, athens.service, sparta.service
#   Requires sudo (or run as root) for /etc/systemd/system and venv under /usr/local/share/dorian.
#
# On success, if this script lives under /tmp/dorian_deploy_* (deploy_license staging), that directory
# is removed so upgrades do not accumulate multiple tarballs and /tmp stays tidy.

set -euo pipefail

log_msg() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] deploy.sh[pid=$$]: $*"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DORIAN_ROOT="/usr/local/share/dorian"
GEODB_DIR="${DORIAN_ROOT}/athens/nginx/lua/geoip2"
ANGELOS_DIR="${DORIAN_ROOT}/angelos"
ANGELOS_VENV="${ANGELOS_DIR}/venv"

LICENSE_TAR="${SCRIPT_DIR}/license.tar.gz"
GEODB_TAR="${SCRIPT_DIR}/dbip-full-2026-02.mmdb.tar.gz"

usage() {
  echo "Usage: $(basename "$0") [--all | --license-only | --version-only]" >&2
  echo "  --all (default)   full extract + angelos venv + systemd enable" >&2
  echo "  --license-only    only unpack license.tar.gz (no venv, no systemd)" >&2
  echo "  --version-only    only unpack dorian tarball + venv + systemd" >&2
}

fail() {
  echo "error: $*" >&2
  exit 1
}

maybe_sudo() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

setup_angelos_venv() {
  [[ -d "${ANGELOS_DIR}" ]] || fail "missing angelos directory: ${ANGELOS_DIR}"
  [[ -f "${ANGELOS_DIR}/requirements.txt" ]] || fail "missing ${ANGELOS_DIR}/requirements.txt"

  if [[ ! -d "${ANGELOS_VENV}" ]]; then
    maybe_sudo python3 -m venv "${ANGELOS_VENV}"
    echo "created venv: ${ANGELOS_VENV}"
  else
    echo "using existing venv: ${ANGELOS_VENV}"
  fi

  maybe_sudo "${ANGELOS_VENV}/bin/python" -m pip install --upgrade pip
  maybe_sudo "${ANGELOS_VENV}/bin/pip" install -r "${ANGELOS_DIR}/requirements.txt"
  echo "installed angelos Python requirements into ${ANGELOS_VENV}"
}

install_systemd_units() {
  local -a units=(
    "${DORIAN_ROOT}/angelos/angelos.service"
    "${DORIAN_ROOT}/athens/athens.service"
    "${DORIAN_ROOT}/sparta/service/sparta.service"
  )
  local u dest_name
  for u in "${units[@]}"; do
    [[ -f "${u}" ]] || fail "missing unit file: ${u}"
    dest_name="$(basename "${u}")"
    maybe_sudo install -m 644 "${u}" "/etc/systemd/system/${dest_name}"
    echo "installed systemd unit: /etc/systemd/system/${dest_name}"
  done

  maybe_sudo systemctl daemon-reload

  for dest_name in angelos.service athens.service sparta.service; do
    maybe_sudo systemctl enable --now "${dest_name}"
    echo "enabled and started: ${dest_name}"
  done
}

post_install_after_dorian_extract() {
  setup_angelos_venv
  install_systemd_units
}

# deploy_license uploads to /tmp/dorian_deploy_<token>/; remove it after artifacts are installed.
cleanup_remote_staging_dir() {
  case "${SCRIPT_DIR}" in
    /tmp/dorian_deploy_*)
      log_msg "removing staging directory ${SCRIPT_DIR}"
      if ! ( cd / && rm -rf -- "${SCRIPT_DIR}" ); then
        log_msg "warning: could not remove staging directory ${SCRIPT_DIR}"
      fi
      ;;
  esac
}

# $1: when "newest" and multiple tarballs exist (reused upgrade staging dir), pick newest mtime instead of failing.
find_dorian_tarball() {
  local ambiguous_policy="${1:-strict}"
  shopt -s nullglob
  local -a candidates=( "${SCRIPT_DIR}"/dorian-ddos-firewall-*.tar.gz )
  shopt -u nullglob
  if ((${#candidates[@]} == 0)); then
    echo "error: no dorian-ddos-firewall-*.tar.gz found in ${SCRIPT_DIR}" >&2
    return 1
  fi
  if ((${#candidates[@]} > 1)); then
    if [[ "${ambiguous_policy}" != "newest" ]]; then
      echo "error: expected exactly one dorian-ddos-firewall-*.tar.gz in ${SCRIPT_DIR}, found ${#candidates[@]}" >&2
      return 1
    fi
    local best="${candidates[0]}"
    local best_time=0
    local c t
    for c in "${candidates[@]}"; do
      t=$(stat -c '%Y' "$c" 2>/dev/null) || t=0
      if (( t > best_time )); then
        best_time=$t
        best=$c
      elif (( t == best_time )) && [[ "$(basename "$c")" > "$(basename "$best")" ]]; then
        best=$c
      fi
    done
    printf '%s' "${best}"
    return 0
  fi
  printf '%s' "${candidates[0]}"
}

extract_dorian_version() {
  local tar_path
  local ambiguous_policy="strict"
  if [[ "${DEPLOY_MODE}" == "version" ]]; then
    ambiguous_policy="newest"
  fi
  if ! tar_path="$(find_dorian_tarball "${ambiguous_policy}")"; then
    fail "dorian tarball resolution failed"
  fi
  [[ -f "$tar_path" ]] || fail "missing dorian tarball: ${tar_path}"
  mkdir -p "${DORIAN_ROOT}"
  tar -xzf "${tar_path}" -C "${DORIAN_ROOT}"
  echo "extracted $(basename "${tar_path}") -> ${DORIAN_ROOT}/"
}

extract_license() {
  [[ -f "${LICENSE_TAR}" ]] || fail "missing ${LICENSE_TAR}"
  mkdir -p "${DORIAN_ROOT}"
  tar -xzf "${LICENSE_TAR}" -C "${DORIAN_ROOT}"
  echo "extracted $(basename "${LICENSE_TAR}") -> ${DORIAN_ROOT}/"
}

extract_geodb() {
  [[ -f "${GEODB_TAR}" ]] || fail "missing ${GEODB_TAR}"
  mkdir -p "${GEODB_DIR}"
  tar -xzf "${GEODB_TAR}" -C "${GEODB_DIR}"
  echo "extracted $(basename "${GEODB_TAR}") -> ${GEODB_DIR}/"
}

DEPLOY_MODE="all"
if [[ $# -eq 0 ]]; then
  DEPLOY_MODE="all"
elif [[ $# -eq 1 ]]; then
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --all) DEPLOY_MODE="all" ;;
    --license-only) DEPLOY_MODE="license" ;;
    --version-only) DEPLOY_MODE="version" ;;
    *) fail "unknown option: $1 (use --help)" ;;
  esac
else
  fail "too many arguments; pass at most one of --all, --license-only, --version-only"
fi

log_msg "starting deploy mode=${DEPLOY_MODE} script_dir=${SCRIPT_DIR}"

case "${DEPLOY_MODE}" in
  all)
    log_msg "phase=all (dorian tarball + license + geodb + venv/systemd)"
    extract_dorian_version
    extract_license
    extract_geodb
    post_install_after_dorian_extract
    ;;
  license)
    log_msg "phase=license-only (license.tar.gz only)"
    extract_license
    ;;
  version)
    log_msg "phase=version-only (dorian tarball + venv/systemd)"
    extract_dorian_version
    post_install_after_dorian_extract
    ;;
  *)
    fail "internal error: invalid DEPLOY_MODE=${DEPLOY_MODE}"
    ;;
esac

cleanup_remote_staging_dir
log_msg "finished successfully mode=${DEPLOY_MODE}"
