# deploy_license

HTTP API service for provisioning Dorian DDoS Firewall installations on remote
servers. It generates a machine-bound license, uploads the product tarball,
license tarball, and GeoIP database over SSH, then runs `deploy.sh` on the
target host to extract artifacts and bring up the `angelos`, `athens`, and
`sparta` systemd services.

Built with Node.js / Express 5 and MySQL.

> See [`WORKFLOW.md`](./WORKFLOW.md) for the end-to-end procedure of
> provisioning a new server (covers both `odysseus` ingestion and the
> `/create_server` call).

---

## Features

- Generates RSA-signed licenses (`paid` or `trial`) bound to a remote host's
  `machine_id` via the bundled `mklicense` binary.
- Uploads artifacts to the target server with `sshpass` + `scp` and runs
  `bin/deploy.sh` remotely with one of three modes:
  - `all` — Dorian tarball + license + GeoIP, plus Python venv and systemd units.
  - `license_only` — unpack `license.tar.gz` only (no venv, no systemd).
  - `version_only` — Dorian tarball only, plus venv and systemd units.
- Tracks servers, product versions, and an audit history in MySQL
  (`license`, `versions`, `history` tables).
- Per-request logging plus per-session log files in `logs/`.
- Swagger UI for interactive API exploration at `/docs`.

---

## Requirements

- Node.js (Express 5 requires Node 18+)
- MySQL 5.7+ / MariaDB
- `sshpass`, `ssh`, `scp`, `tar` available in `PATH` (the API uses them to
  talk to target servers)
- On target servers: `bash`, `tar`, `python3` with `venv`, `systemd`, and
  `sudo` (or root) for `--all` / `--version-only` deploys

The native helpers in `bin/` (`mklicense`, `machine_id`, `parse_license`) are
prebuilt for Linux x86_64 and committed to the repository. Their sources
(`*.c`) are alongside them if rebuilds are required.

---

## Installation

```bash
git clone <repo-url> deploy_license
cd deploy_license
npm install
```

Initialize the database schema:

```bash
mysql -u root -p < schema.sql
```

This creates the `lic` database with three tables:

- `license` — one row per provisioned server (uuid, ip, ssh creds, machine_id,
  license blob, expiry, etc.)
- `versions` — Dorian product tarballs available for deployment
  (`uuid`, `version`, `full_name`, `path`)
- `history` — append-only audit log keyed by license `uuid`

---

## Configuration

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable      | Default     | Description                                  |
| ------------- | ----------- | -------------------------------------------- |
| `PORT`        | `9090`      | HTTP listen port                             |
| `DB_HOST`     | `127.0.0.1` | MySQL host                                   |
| `DB_PORT`     | `3306`      | MySQL port                                   |
| `DB_USER`     | `root`      | MySQL user                                   |
| `DB_PASSWORD` | (empty)     | MySQL password                               |
| `DB_NAME`     | `lic`       | MySQL database                               |
| `LOG_DIR`     | `./logs`    | Directory for per-session log files          |

Before deploying, also seed the `versions` table with at least one row whose
`path` points to a readable `dorian-ddos-firewall-*.tar.gz` on the API host,
and place the GeoIP archive at `bin/geodb/dbip-full-2026-02.mmdb.tar.gz`.

---

## Running

```bash
npm start
```

The server listens on `PORT` (default `9090`). On startup it logs:

```
deploy_license API running on port 9090
```

Swagger UI is served at `http://<host>:<port>/docs` and a basic liveness
check at `http://<host>:<port>/health`.

---

## API

Full schemas live in `openapi.yaml` (and at `/docs`). Quick reference:

### `GET /get_versions`

Returns Dorian product versions from the `versions` table, newest first.

```json
{
  "versions": [
    {
      "uuid": "…",
      "version": "1.2.3",
      "full_name": "dorian-ddos-firewall-1.2.3",
      "path": "/srv/releases/dorian-ddos-firewall-1.2.3.tar.gz",
      "updated": "2026-05-13T00:00:00.000Z"
    }
  ]
}
```

### `POST /create_server`

Generates (or resolves an existing) license, uploads artifacts, and runs
`deploy.sh` on the target.

Request body:

```json
{
  "name": "edge-01",
  "ip": "10.0.0.10",
  "user": "root",
  "pass": "…",
  "ssh_port": 22,
  "license_type": "trial",
  "token": "…",
  "deploy_mode": "all"
}
```

- `license_type`: `trial` or `paid` (case-insensitive). For `paid`, also send
  `license_string` matching an existing row in the `license` table.
- `deploy_mode` (optional): `all` (default), `license_only`, or
  `version_only`.

### `POST /upgrade_version`

Uploads a selected Dorian tarball and runs `deploy.sh --version-only` on the
target (no license regeneration).

```json
{
  "name": "edge-01",
  "ip": "10.0.0.10",
  "user": "root",
  "pass": "…",
  "ssh_port": 22,
  "token": "…",
  "version_uuid": "<row uuid from /get_versions>"
}
```

### `GET /health`

Returns `{"status":"ok"}`.

### `GET /docs`

Swagger UI rendered from `openapi.yaml`.

---

## Project layout

```
deploy_license/
├── server.js                 Express app: routes, validation, SSH/SCP orchestration
├── openapi.yaml              OpenAPI 3.0 spec (rendered at /docs)
├── schema.sql                MySQL schema (license, versions, history)
├── package.json
├── .env.example              Environment variable template
├── bin/
│   ├── deploy.sh             Runs on the target server; extracts artifacts + systemd
│   ├── generate_license.sh   Wraps machine_id lookup + key gen + mklicense
│   ├── get_remote_machine_id.sh
│   ├── gen_server_keys.sh    Generates RSA keypair per license run
│   ├── mklicense / mklicense.c
│   ├── machine_id / machine_id.c
│   ├── parse_license / parse_license.c
│   ├── geodb/                Holds dbip-full-*.mmdb.tar.gz (gitignored)
│   ├── licenses/             Generated licenses keyed by machine_id/timestamp
│   └── secrets/              Server-level keypair (do not commit)
└── logs/                     Per-session log files (gitignored)
```

---

## How a `create_server` request flows

1. Validate payload (AJV against the schema in `server.js`).
2. Fetch the latest row from `versions`; resolve the local Dorian tarball.
3. For `trial`: call `bin/generate_license.sh` to SSH to the target, read its
   `machine_id`, generate an RSA keypair, and run `mklicense` to produce a
   signed `license.lic`. For `paid`: look up an existing license by
   `license_string` in the `license` table.
4. Build `license.tar.gz` containing the license artifacts.
5. `scp` the Dorian tarball, `license.tar.gz`, GeoIP archive, and `deploy.sh`
   into `/tmp/dorian_deploy_<token>/` on the target.
6. Run `bash deploy.sh --<mode>` remotely. On success the staging directory
   is removed and `athens.service` status is reported back.
7. Persist / update the row in `license` and append a row to `history`.

---

## Notes & gotchas

- `bin/deploy.sh` requires root (or `sudo`) on the target for venv creation
  under `/usr/local/share/dorian` and for installing systemd units.
- `sshpass` is used because target servers are provisioned with password
  authentication. SSH passwords are never written to disk by the API; they
  are passed via process arguments and redacted in logs.
- License files are stored under `bin/licenses/<machine_id>/<UTC timestamp>/`
  along with an `info.txt` describing the run.
- `.env`, `logs/`, `node_modules/`, and `bin/geodb/*` are gitignored.
