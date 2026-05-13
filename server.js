require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const YAML = require("yamljs");
const swaggerUi = require("swagger-ui-express");
const Ajv = require("ajv");

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  req._reqId = crypto.randomUUID();
  const t0 = Date.now();
  deployLog("info", req._reqId, `-> ${req.method} ${req.originalUrl || req.url}`);
  res.on("finish", () => {
    const ms = Date.now() - t0;
    deployLog("info", req._reqId, `<- ${res.statusCode} in ${ms}ms`);
  });
  next();
});

const PORT = Number(process.env.PORT || 9090);
const LOG_DIR = process.env.LOG_DIR
  ? path.resolve(process.env.LOG_DIR)
  : path.join(__dirname, "logs");
const BIN_DIR = path.join(__dirname, "bin");
const MACHINE_ID_BIN = path.join(BIN_DIR, "machine_id");
const GENERATE_LICENSE_SH = path.join(BIN_DIR, "generate_license.sh");
const DEPLOY_SH = path.join(BIN_DIR, "deploy.sh");
const GEODB_MMDB_TAR_GZ = path.join(BIN_DIR, "geodb", "dbip-full-2026-02.mmdb.tar.gz");
// Supported license_type values and their generation defaults.
// Trial is always auto-generated (3-day duration). L4 / L7 / Unified are auto-generated
// by default but may instead reuse an existing license row when license_string is provided.
const LICENSE_TYPES = {
  trial:   { feature: 7, durationDays: 3,   allowReuse: false },
  l4:      { feature: 1, durationDays: 365, allowReuse: true },
  l7:      { feature: 2, durationDays: 365, allowReuse: true },
  unified: { feature: 3, durationDays: 365, allowReuse: true },
};
const REMOTE_DEPLOY_PREFIX = "/tmp/dorian_deploy";

function deployLog(level, reqId, msg, meta = null) {
  const ts = new Date().toISOString();
  if (meta && typeof meta === "object" && Object.keys(meta).length) {
    console.log(`[deploy_license][${ts}][${level}][req=${reqId}] ${msg}`, meta);
  } else {
    console.log(`[deploy_license][${ts}][${level}][req=${reqId}] ${msg}`);
  }
}

/** Redact sshpass -p PASSWORD for logs */
function argvForLog(cmd, args) {
  const parts = [cmd, ...args];
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (String(parts[i]) === "-p" && i + 1 < parts.length) {
      out.push("-p", "***");
      i++;
      continue;
    }
    out.push(parts[i]);
  }
  return out.join(" ");
}

const ajv = new Ajv({ allErrors: true, removeAdditional: true });

const dbPool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "lic",
  waitForConnections: true,
  connectionLimit: 10,
});

const apiSpec = YAML.load(path.join(__dirname, "openapi.yaml"));

const validateCreateServer = ajv.compile({
  type: "object",
  required: ["name", "ip", "user", "pass", "ssh_port", "license_type", "token"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1 },
    ip: { type: "string", minLength: 1 },
    user: { type: "string", minLength: 1 },
    pass: { type: "string", minLength: 1 },
    ssh_port: { anyOf: [{ type: "string", minLength: 1 }, { type: "number" }] },
    license_type: { type: "string", minLength: 1 },
    license_string: { type: "string" },
    token: { type: "string", minLength: 1 },
    deploy_mode: { type: "string", enum: ["all", "license_only", "version_only"] },
  },
});

const validateUpgradeVersion = ajv.compile({
  type: "object",
  required: ["name", "ip", "user", "pass", "ssh_port", "token", "version_uuid"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1 },
    ip: { type: "string", minLength: 1 },
    user: { type: "string", minLength: 1 },
    pass: { type: "string", minLength: 1 },
    ssh_port: { anyOf: [{ type: "string", minLength: 1 }, { type: "number" }] },
    token: { type: "string", minLength: 1 },
    version_uuid: { type: "string", minLength: 1 },
    license_type: { type: "string", minLength: 1 },
  },
});

async function appendSessionLog(ip, token, event, payload = {}) {
  await fs.mkdir(LOG_DIR, { recursive: true });
  const safeIp = String(ip).replace(/[^a-zA-Z0-9_.-]/g, "_");
  const safeToken = String(token).replace(/[^a-zA-Z0-9_.-]/g, "_");
  const filePath = path.join(LOG_DIR, `${safeIp}__${safeToken}.log`);
  const line = `${new Date().toISOString()} ${event} ${JSON.stringify(payload)}\n`;
  await fs.appendFile(filePath, line, "utf8");
}

async function writeHistory(uuid, description) {
  await dbPool.execute("INSERT INTO history (uuid, description) VALUES (?, ?)", [uuid, description]);
}

function validationError(res, validateFn) {
  return res.status(400).json({
    description: "invalid request payload",
    errors: validateFn.errors || [],
  });
}

/** Normalize DB `expire_date` (Date or string) to ISO for API clients. */
function licenseExpireToIso(value) {
  if (value == null || value === "") return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}

function runCommand(cmd, args, options = {}) {
  const { logContext, ...spawnOpts } = options;
  const t0 = Date.now();
  if (logContext?.reqId) {
    deployLog("info", logContext.reqId, `exec start: ${argvForLog(cmd, args)}`, { step: logContext.step });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "pipe",
      ...spawnOpts,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      const ms = Date.now() - t0;
      if (logContext?.reqId) {
        deployLog("error", logContext.reqId, `exec spawn error after ${ms}ms: ${err.message}`, {
          step: logContext.step,
          cmd: cmd,
        });
      }
      reject(err);
    });
    child.on("close", (code) => {
      const ms = Date.now() - t0;
      if (logContext?.reqId) {
        const tail = (s, n) => (s && s.length > n ? `${s.slice(-n)}…(len=${s.length})` : s || "");
        deployLog(code === 0 ? "info" : "error", logContext.reqId, `exec end code=${code} in ${ms}ms`, {
          step: logContext.step,
          stdoutLen: stdout.length,
          stderrLen: stderr.length,
          stderrTail: tail(stderr.trim(), 400),
        });
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const err = new Error(stderr.trim() || stdout.trim() || `${cmd} exited with code ${code}`);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

function runGenerateLicenseScript({ ip, user, pass, sshPort, licenseType, durationDays, feature, logContext }) {
  return new Promise((resolve, reject) => {
    if (logContext?.reqId) {
      deployLog("info", logContext.reqId, "generate_license.sh starting", {
        step: "generate_license",
        ip,
        sshPort,
        licenseType,
        durationDays,
        feature,
      });
    }
    const scriptArgs = [
      GENERATE_LICENSE_SH,
      "--license_type",
      licenseType,
      "--duration",
      String(durationDays),
      "--ip",
      String(ip),
      "--user",
      String(user),
      "--pass",
      String(pass),
      "--ssh_port",
      String(sshPort),
    ];
    if (feature != null) {
      scriptArgs.push("--feature", String(feature));
    }
    const child = spawn(
      "bash",
      scriptArgs,
      {
        cwd: BIN_DIR,
        stdio: "pipe",
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (e) => {
      if (logContext?.reqId) {
        deployLog("error", logContext.reqId, `generate_license spawn error: ${e.message}`, { step: "generate_license" });
      }
      reject(e);
    });
    child.on("close", (code) => {
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || "";
      if (last.startsWith("success: ")) {
        if (logContext?.reqId) {
          deployLog("info", logContext.reqId, "generate_license.sh success", {
            step: "generate_license",
            licensePath: last.slice("success: ".length).trim(),
          });
        }
        resolve({
          licensePath: last.slice("success: ".length).trim(),
          stdout,
          stderr,
        });
        return;
      }
      if (last.startsWith("error: ")) {
        const payload = {
          description: "generate_license.sh failed",
          script_error: last.slice("error: ".length).trim(),
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exit_code: code,
        };
        if (logContext?.reqId) {
          deployLog("error", logContext.reqId, "generate_license.sh reported error line", payload);
        }
        const err = new Error(payload.script_error);
        err.generateLicensePayload = payload;
        reject(err);
        return;
      }
      const payload = {
        description: "generate_license.sh failed",
        script_error: stderr.trim() || stdout.trim() || `unexpected exit code ${code}`,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exit_code: code,
      };
      if (logContext?.reqId) {
        deployLog("error", logContext.reqId, "generate_license.sh unexpected exit", payload);
      }
      const err = new Error(payload.script_error);
      err.generateLicensePayload = payload;
      reject(err);
    });
  });
}

function parseMachineIdFromLicensePath(licenseFilePath) {
  const normalized = path.resolve(licenseFilePath);
  const parts = normalized.split(path.sep);
  const idx = parts.lastIndexOf("licenses");
  if (idx >= 0 && parts[idx + 1]) {
    return parts[idx + 1];
  }
  throw new Error("could not parse machine_id from license path");
}

async function getLatestDorianVersionRow() {
  const [rows] = await dbPool.execute(
    "SELECT uuid, version, full_name, path FROM versions ORDER BY updated DESC, id DESC LIMIT 1"
  );
  if (!rows.length || !rows[0].path) {
    const err = new Error("no dorian product path found in versions table");
    err.code = "NO_VERSION";
    throw err;
  }
  return rows[0];
}

function safeRemoteTokenSegment(token) {
  return String(token)
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 64);
}

const SSH_OPTS = ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR"];

async function ensureRemoteDir({ ip, user, pass, sshPort, remoteDir, logContext }) {
  await runCommand(
    "sshpass",
    [
      "-p",
      String(pass),
      "ssh",
      ...SSH_OPTS,
      "-p",
      String(sshPort),
      `${user}@${ip}`,
      `mkdir -p -- ${JSON.stringify(remoteDir)}`,
    ],
    { logContext: { ...logContext, step: "ssh_mkdir" } }
  );
}

/** Reuse of remoteDir (e.g. upgrade_version) leaves prior dorian-*.tar.gz; deploy.sh requires exactly one match. */
async function removeRemoteDorianTarballs({ ip, user, pass, sshPort, remoteDir, logContext }) {
  const cmd = `cd -- ${JSON.stringify(remoteDir)} && rm -f dorian-ddos-firewall-*.tar.gz`;
  await runCommand(
    "sshpass",
    [
      "-p",
      String(pass),
      "ssh",
      ...SSH_OPTS,
      "-p",
      String(sshPort),
      `${user}@${ip}`,
      cmd,
    ],
    { logContext: { ...logContext, step: "ssh_rm_old_dorian_tarballs" } }
  );
}

async function scpFilesToRemote({ ip, user, pass, sshPort, localFiles, remoteDir, logContext }) {
  if (!localFiles.length) {
    return;
  }
  const dest = `${user}@${ip}:${remoteDir}/`;
  await runCommand(
    "sshpass",
    ["-p", String(pass), "scp", ...SSH_OPTS, "-P", String(sshPort), ...localFiles, dest],
    { logContext: { ...logContext, step: "scp_upload", fileCount: localFiles.length } }
  );
}

/**
 * When remote deploy.sh extracted files but systemctl enable/start failed, stderr contains
 * "Job for <unit>.service failed ...". Treat as soft-success for API consumers.
 * @returns {string|null} user-facing warning, or null if this does not look like a systemd-only failure
 */
function systemdServiceDeployWarning(stderr, stdout) {
  const text = `${stderr || ""}\n${stdout || ""}`;
  const re = /Job for\s+([\w.-]+\.service)\s+failed[^\n]*/gi;
  const units = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const u = m[1];
    if (!seen.has(u)) {
      seen.add(u);
      units.push(u);
    }
  }
  if (!units.length) {
    return null;
  }
  const names = units.map((u) => u.replace(/\.service$/i, ""));
  if (names.length === 1) {
    return `Deploy done, but ${names[0]} service is not working`;
  }
  if (names.length === 2) {
    return `Deploy done, but ${names[0]} and ${names[1]} services are not working`;
  }
  return `Deploy done, but these services are not working: ${names.join(", ")}`;
}

function deployModeToRemoteFlag(deployMode) {
  const m = deployMode == null || deployMode === "" ? "all" : String(deployMode).toLowerCase();
  if (m === "all") {
    return "--all";
  }
  if (m === "license_only") {
    return "--license-only";
  }
  if (m === "version_only") {
    return "--version-only";
  }
  return null;
}

async function runRemoteDeployScript({ ip, user, pass, sshPort, remoteDir, deployFlag, logContext }) {
  const remoteShell = `cd -- ${JSON.stringify(remoteDir)} && bash deploy.sh ${deployFlag}`;
  await runCommand(
    "sshpass",
    ["-p", String(pass), "ssh", ...SSH_OPTS, "-p", String(sshPort), `${user}@${ip}`, remoteShell],
    { logContext: { ...logContext, step: "ssh_remote_deploy", deployFlag } }
  );
}

/** Remotely read `systemctl is-active athens.service` (stdout only; exit code ignored). */
async function probeRemoteAthensSystemdState({ ip, user, pass, sshPort, logContext }) {
  const script =
    's=$(systemctl is-active athens.service 2>/dev/null || true); printf %s "${s:-unknown}"';
  const remoteShell = `bash -lc ${JSON.stringify(script)}`;
  try {
    const { stdout } = await runCommand(
      "sshpass",
      ["-p", String(pass), "ssh", ...SSH_OPTS, "-p", String(sshPort), `${user}@${ip}`, remoteShell],
      { logContext: { ...logContext, step: "ssh_probe_athens" } }
    );
    return stdout.trim() || "unknown";
  } catch (e) {
    deployLog("warn", logContext.reqId, "probeRemoteAthensSystemdState failed", { message: e.message });
    return "unknown";
  }
}

/**
 * High-level deploy/runtime status for API consumers (dashboard).
 * @param {string} effectiveDeployMode all | license_only | version_only
 * @param {string|null} serviceDeployWarning soft-fail message when systemd start failed
 * @param {string} athensSystemdState output of systemctl is-active for athens.service
 * @returns {"deployed"|"running"|"stopped"}
 */
function deriveCreateServerDeploymentStatus(effectiveDeployMode, serviceDeployWarning, athensSystemdState) {
  const mode = String(effectiveDeployMode || "all").toLowerCase();
  if (mode === "license_only") {
    return "deployed";
  }
  if (serviceDeployWarning) {
    return "stopped";
  }
  const s = String(athensSystemdState || "")
    .trim()
    .toLowerCase();
  if (s === "active" || s === "activating" || s === "reloading") {
    return "running";
  }
  if (s === "failed" || s === "inactive" || s === "dead") {
    return "stopped";
  }
  return "deployed";
}

app.get("/get_versions", async (req, res) => {
  const reqId = req._reqId || crypto.randomUUID();
  try {
    const [rows] = await dbPool.execute(
      "SELECT uuid, version, full_name, path, updated FROM versions ORDER BY updated DESC, id DESC"
    );
    const versions = (rows || []).map((r) => ({
      uuid: r.uuid,
      version: r.version,
      full_name: r.full_name,
      path: r.path,
      updated:
        r.updated instanceof Date
          ? r.updated.toISOString()
          : r.updated != null
            ? String(r.updated)
            : null,
    }));
    deployLog("info", reqId, "get_versions OK", { count: versions.length });
    return res.status(200).json({ versions });
  } catch (error) {
    deployLog("error", reqId, `get_versions failed: ${error.message}`, {
      code: error.code,
    });
    return res.status(500).json({
      code: 5000,
      description: "get_versions failed",
      error: error.message,
    });
  }
});

async function createLicenseTarball({ machineIdBin, licenseFile, publicKeyPem, token, workDir, logContext }) {
  const bundleDir = path.join(workDir, "license");
  await fs.mkdir(bundleDir, { recursive: true });
  await fs.copyFile(machineIdBin, path.join(bundleDir, "machine_id"));
  await fs.copyFile(licenseFile, path.join(bundleDir, "license.lic"));
  await fs.copyFile(publicKeyPem, path.join(bundleDir, "server_public_key.pem"));
  await fs.writeFile(path.join(bundleDir, "token"), String(token), "utf8");

  const tarPath = path.join(workDir, "license.tar.gz");
  await runCommand("tar", ["-czf", tarPath, "-C", workDir, "license"], {
    logContext: { ...logContext, step: "tar_license_bundle" },
  });
  return tarPath;
}

async function insertGeneratedLicenseRow({
  uuid,
  name,
  ip,
  user,
  pass,
  sshPort,
  machineId,
  licenseContent,
  pubKey,
  privateKey,
  token,
  durationDays,
}) {
  await dbPool.execute(
    `INSERT INTO license (uuid, name, ip, user, password, ssh_port, machine_id, license, pub_key, private_key, token, expire_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY))`,
    [
      uuid,
      name,
      ip,
      user,
      pass,
      Number(sshPort),
      machineId,
      licenseContent,
      pubKey,
      privateKey,
      token,
      Number(durationDays),
    ]
  );
}

async function updateExistingLicenseConnection({ id, name, ip, user, pass, sshPort, token }) {
  await dbPool.execute(
    `UPDATE license SET name = ?, ip = ?, user = ?, password = ?, ssh_port = ?, token = ?, updated = CURRENT_TIMESTAMP WHERE id = ?`,
    [name, ip, user, pass, Number(sshPort), token, id]
  );
}

app.post("/upgrade_version", async (req, res) => {
  const { name, ip, user, pass, ssh_port, token, version_uuid, license_type } = req.body;
  const reqId = req._reqId || crypto.randomUUID();
  const logContext = { reqId };

  if (!validateUpgradeVersion(req.body)) {
    deployLog("warn", reqId, "validation failed for upgrade_version", {
      errors: validateUpgradeVersion.errors,
    });
    return validationError(res, validateUpgradeVersion);
  }

  let workDir;
  try {
    try {
      await fs.access(DEPLOY_SH);
    } catch {
      deployLog("error", reqId, "missing deploy script", { path: DEPLOY_SH });
      return res.status(500).json({
        code: 5000,
        description: `missing deploy script at ${DEPLOY_SH}`,
      });
    }

    const [verRows] = await dbPool.execute(
      "SELECT uuid, version, full_name, path FROM versions WHERE uuid = ? LIMIT 1",
      [version_uuid]
    );
    if (!verRows.length) {
      deployLog("warn", reqId, "version_uuid not found", { version_uuid });
      return res.status(404).json({ description: "version not found" });
    }
    const versionRow = verRows[0];
    const productPath = path.resolve(versionRow.path);
    try {
      await fs.access(productPath);
    } catch {
      deployLog("error", reqId, "dorian product path not readable", { productPath });
      return res.status(500).json({
        code: 5000,
        description: "dorian product path from versions table is not readable on this host",
        path: productPath,
      });
    }

    const ltRaw = String(license_type || "trial").toLowerCase();
    const lt = LICENSE_TYPES[ltRaw] ? ltRaw : "trial";

    let rowUuid = "";
    let machineId = null;
    const [licRows] = await dbPool.execute(
      "SELECT uuid, machine_id, expire_date FROM license WHERE token = ? LIMIT 1",
      [token]
    );
    const licRow = licRows[0];
    if (licRow?.uuid) {
      rowUuid = licRow.uuid;
      machineId = licRow.machine_id;
      await dbPool.execute(
        `UPDATE license SET name = ?, ip = ?, user = ?, password = ?, ssh_port = ?, updated = CURRENT_TIMESTAMP WHERE token = ?`,
        [name, ip, user, pass, Number(ssh_port), token]
      );
    }

    await appendSessionLog(ip, token, "upgrade_version_received", {
      version_uuid,
      version: versionRow.version,
    });

    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "deploy_license-upgrade-"));
    const remoteDir = `${REMOTE_DEPLOY_PREFIX}_${safeRemoteTokenSegment(token)}`;
    const remoteDeployFlag = "--version-only";
    const effectiveDeployMode = "version_only";

    deployLog("info", reqId, "upgrade_version staging", {
      remoteDir,
      product: path.basename(productPath),
      version: versionRow.version,
    });
    await ensureRemoteDir({ ip, user, pass, sshPort: ssh_port, remoteDir, logContext });
    await removeRemoteDorianTarballs({ ip, user, pass, sshPort: ssh_port, remoteDir, logContext });
    await scpFilesToRemote({
      ip,
      user,
      pass,
      sshPort: ssh_port,
      localFiles: [productPath, DEPLOY_SH],
      remoteDir,
      logContext,
    });

    deployLog("info", reqId, "running remote deploy.sh", { remoteDeployFlag, remoteDir });
    let serviceDeployWarning = null;
    try {
      await runRemoteDeployScript({
        ip,
        user,
        pass,
        sshPort: ssh_port,
        remoteDir,
        deployFlag: remoteDeployFlag,
        logContext,
      });
    } catch (remoteErr) {
      serviceDeployWarning = systemdServiceDeployWarning(remoteErr.stderr, remoteErr.stdout);
      if (!serviceDeployWarning) {
        throw remoteErr;
      }
      deployLog("warn", reqId, "remote deploy.sh exited non-zero; treating as success (artifacts deployed)", {
        warning: serviceDeployWarning,
        exitCode: remoteErr.code,
      });
    }

    const athensSystemdState = await probeRemoteAthensSystemdState({
      ip,
      user,
      pass,
      sshPort: ssh_port,
      logContext,
    });
    const serverStatus = deriveCreateServerDeploymentStatus(
      effectiveDeployMode,
      serviceDeployWarning,
      athensSystemdState
    );

    let expireDateIso = "";
    if (rowUuid) {
      const [expRows] = await dbPool.execute("SELECT expire_date FROM license WHERE uuid = ? LIMIT 1", [rowUuid]);
      expireDateIso = licenseExpireToIso(expRows[0]?.expire_date);
    }

    await appendSessionLog(ip, token, serviceDeployWarning ? "upgrade_version_completed_with_warning" : "upgrade_version_completed", {
      remoteDir,
      version: versionRow.version,
      server_status: serverStatus,
      ...(serviceDeployWarning ? { service_deploy_warning: serviceDeployWarning } : {}),
    });

    if (rowUuid) {
      await writeHistory(rowUuid, `upgrade_version to ${versionRow.version} for ip=${ip}`);
    }

    const defaultDescription = "Dorian version upgraded (deploy.sh --version-only)";
    const responsePayload = {
      description: serviceDeployWarning || defaultDescription,
      license_type: lt,
      version: versionRow.version,
      expire_date: expireDateIso,
      server_status: serverStatus,
      uuid: rowUuid,
      machine_id: machineId,
      remote_dir: remoteDir,
      deploy_mode: effectiveDeployMode,
      remote_deploy_flag: remoteDeployFlag,
      uploaded_files: [path.basename(productPath), path.basename(DEPLOY_SH)],
      dorian_version: {
        version: versionRow.version,
        full_name: versionRow.full_name,
        uuid: versionRow.uuid,
      },
      ...(serviceDeployWarning ? { service_deploy_warning: serviceDeployWarning } : {}),
    };
    deployLog("info", reqId, "upgrade_version success", {
      version: versionRow.version,
      server_status: serverStatus,
    });
    return res.status(200).json(responsePayload);
  } catch (error) {
    await appendSessionLog(ip, token, "upgrade_version_failed", { error: error.message, code: error.code });
    deployLog("error", reqId, `upgrade_version failed: ${error.message}`, {
      code: error.code,
    });
    return res.status(500).json({
      code: 5000,
      description: "upgrade_version failed",
      error: error.message,
    });
  } finally {
    if (workDir) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

app.post("/create_server", async (req, res) => {
  const { name, ip, user, pass, ssh_port, license_type, license_string, token, deploy_mode } = req.body;
  const reqId = req._reqId || crypto.randomUUID();

  if (!validateCreateServer(req.body)) {
    deployLog("warn", reqId, "validation failed for create_server", {
      errors: validateCreateServer.errors,
    });
    return validationError(res, validateCreateServer);
  }

  const lt = String(license_type).toLowerCase();
  const ltConfig = LICENSE_TYPES[lt];
  if (!ltConfig) {
    deployLog("warn", reqId, "invalid license_type", { license_type: lt });
    return res.status(400).json({
      description: `license_type must be one of: ${Object.keys(LICENSE_TYPES).join(", ")}`,
    });
  }

  const hasLicenseString = license_string != null && String(license_string).trim() !== "";
  if (hasLicenseString && !ltConfig.allowReuse) {
    deployLog("warn", reqId, "license_string supplied for license_type that does not support reuse", {
      license_type: lt,
    });
    return res.status(400).json({
      description: `license_string is only accepted when license_type is one of: ${Object.keys(LICENSE_TYPES)
        .filter((k) => LICENSE_TYPES[k].allowReuse)
        .join(", ")}`,
    });
  }
  const reuseExistingLicense = hasLicenseString;

  const logContext = { reqId };
  deployLog("info", reqId, "create_server accepted", {
    name,
    ip,
    user,
    ssh_port,
    license_type: lt,
    deploy_mode: deploy_mode ?? "default",
    license_string_len: hasLicenseString ? String(license_string).length : 0,
    license_path: reuseExistingLicense ? "reuse_existing" : "generate_new",
  });

  const deployFlag = deployModeToRemoteFlag(deploy_mode);

  let workDir;
  try {
    await appendSessionLog(ip, token, "create_server_received", { name, ssh_port, license_type: lt });

    try {
      await fs.access(MACHINE_ID_BIN);
    } catch {
      deployLog("error", reqId, "missing machine_id binary", { path: MACHINE_ID_BIN });
      return res.status(500).json({
        code: 5000,
        description: `missing machine_id binary at ${MACHINE_ID_BIN}; build from machine_id.c`,
      });
    }

    try {
      await fs.access(DEPLOY_SH);
    } catch {
      deployLog("error", reqId, "missing deploy script", { path: DEPLOY_SH });
      return res.status(500).json({
        code: 5000,
        description: `missing deploy script at ${DEPLOY_SH}`,
      });
    }

    try {
      await fs.access(GEODB_MMDB_TAR_GZ);
    } catch {
      deployLog("error", reqId, "missing GeoIP archive", { path: GEODB_MMDB_TAR_GZ });
      return res.status(500).json({
        code: 5000,
        description: `missing GeoIP database archive at ${GEODB_MMDB_TAR_GZ}`,
      });
    }

    let rowUuid;
    let machineId;
    let licenseContent;
    let pubKey;
    let privateKey;
    let licenseFilePath;
    let publicKeyPath;

    if (!reuseExistingLicense) {
      deployLog("info", reqId, `license path: generate new ${lt} license`, {
        feature: ltConfig.feature,
        durationDays: ltConfig.durationDays,
      });
      let genOut;
      try {
        genOut = await runGenerateLicenseScript({
          ip,
          user,
          pass,
          sshPort: ssh_port,
          licenseType: lt,
          durationDays: ltConfig.durationDays,
          feature: ltConfig.feature,
          logContext,
        });
      } catch (e) {
        deployLog("error", reqId, "generate_license failed", { message: e.message });
        await appendSessionLog(ip, token, "generate_license_failed", e.generateLicensePayload || { error: e.message });
        if (e.generateLicensePayload) {
          return res.status(500).json({ code: 5000, ...e.generateLicensePayload });
        }
        return res.status(500).json({
          code: 5000,
          description: "generate_license.sh failed",
          error: e.message,
          stderr: e.stderr,
          stdout: e.stdout,
        });
      }

      licenseFilePath = path.resolve(genOut.licensePath);
      const workFolder = path.dirname(licenseFilePath);
      publicKeyPath = path.join(workFolder, "secrets", "server_public_key.pem");
      const privateKeyPath = path.join(workFolder, "secrets", "server_private_key.pem");

      machineId = parseMachineIdFromLicensePath(licenseFilePath);
      licenseContent = await fs.readFile(licenseFilePath, "utf8");
      pubKey = await fs.readFile(publicKeyPath, "utf8");
      privateKey = await fs.readFile(privateKeyPath, "utf8");

      rowUuid = crypto.randomUUID();
      await insertGeneratedLicenseRow({
        uuid: rowUuid,
        name,
        ip,
        user,
        pass,
        sshPort: ssh_port,
        machineId,
        licenseContent,
        pubKey,
        privateKey,
        token,
        durationDays: ltConfig.durationDays,
      });
      await writeHistory(
        rowUuid,
        `${lt} license generated (feature=${ltConfig.feature}, duration=${ltConfig.durationDays}d) for machine_id=${machineId} ip=${ip}`
      );
      deployLog("info", reqId, `${lt} license row inserted`, { rowUuid, machineId });

      workDir = await fs.mkdtemp(path.join(os.tmpdir(), `deploy_license-${lt}-`));
    } else {
      deployLog("info", reqId, `license path: reuse existing license row (license_type=${lt})`);
      const [rows] = await dbPool.execute(
        "SELECT id, uuid, machine_id, license, pub_key, private_key FROM license WHERE license = ? LIMIT 1",
        [license_string]
      );
      if (!rows.length) {
        deployLog("warn", reqId, "license_string not found in DB");
        await appendSessionLog(ip, token, "license_validation_failed", { reason: "license_string not found" });
        return res.status(404).json({ description: "license not found" });
      }
      const row = rows[0];
      rowUuid = row.uuid;
      machineId = row.machine_id;
      licenseContent = row.license;
      pubKey = row.pub_key;
      privateKey = row.private_key;
      if (!pubKey || licenseContent == null || licenseContent === "") {
        deployLog("error", reqId, "license row missing pub_key or license content", { rowId: row.id });
        return res.status(500).json({
          code: 5000,
          description: "license row is missing license or pub_key data",
        });
      }

      await updateExistingLicenseConnection({
        id: row.id,
        name,
        ip,
        user,
        pass,
        sshPort: ssh_port,
        token,
      });

      workDir = await fs.mkdtemp(path.join(os.tmpdir(), `deploy_license-${lt}-reuse-`));
      licenseFilePath = path.join(workDir, "license.lic");
      publicKeyPath = path.join(workDir, "server_public_key.pem");
      await fs.writeFile(licenseFilePath, licenseContent, "utf8");
      await fs.writeFile(publicKeyPath, pubKey, "utf8");
      await writeHistory(rowUuid, `${lt} license reused (license_string match) for ip=${ip}`);
    }

    const versionRow = await getLatestDorianVersionRow();
    const productPath = path.resolve(versionRow.path);
    try {
      await fs.access(productPath);
    } catch {
      deployLog("error", reqId, "dorian product path not readable", { productPath });
      return res.status(500).json({
        code: 5000,
        description: "dorian product path from versions table is not readable on this host",
        path: productPath,
      });
    }

    const tarballPath = await createLicenseTarball({
      machineIdBin: MACHINE_ID_BIN,
      licenseFile: licenseFilePath,
      publicKeyPem: publicKeyPath,
      token,
      workDir,
      logContext,
    });

    const remoteDir = `${REMOTE_DEPLOY_PREFIX}_${safeRemoteTokenSegment(token)}`;
    deployLog("info", reqId, "remote deploy staging", {
      remoteDir,
      tarball: path.basename(tarballPath),
      product: path.basename(productPath),
    });
    await ensureRemoteDir({ ip, user, pass, sshPort: ssh_port, remoteDir, logContext });
    await scpFilesToRemote({
      ip,
      user,
      pass,
      sshPort: ssh_port,
      localFiles: [tarballPath, productPath, DEPLOY_SH, GEODB_MMDB_TAR_GZ],
      remoteDir,
      logContext,
    });

    const effectiveDeployMode = deploy_mode == null || deploy_mode === "" ? "all" : String(deploy_mode).toLowerCase();
    const remoteDeployFlag = deployFlag || "--all";
    deployLog("info", reqId, "running remote deploy.sh", { remoteDeployFlag, remoteDir });
    let serviceDeployWarning = null;
    try {
      await runRemoteDeployScript({
        ip,
        user,
        pass,
        sshPort: ssh_port,
        remoteDir,
        deployFlag: remoteDeployFlag,
        logContext,
      });
    } catch (remoteErr) {
      serviceDeployWarning = systemdServiceDeployWarning(remoteErr.stderr, remoteErr.stdout);
      if (!serviceDeployWarning) {
        throw remoteErr;
      }
      deployLog("warn", reqId, "remote deploy.sh exited non-zero; treating as success (artifacts deployed)", {
        warning: serviceDeployWarning,
        exitCode: remoteErr.code,
      });
    }

    let athensSystemdState = "unknown";
    if (effectiveDeployMode !== "license_only") {
      athensSystemdState = await probeRemoteAthensSystemdState({
        ip,
        user,
        pass,
        sshPort: ssh_port,
        logContext,
      });
    }
    const serverStatus = deriveCreateServerDeploymentStatus(
      effectiveDeployMode,
      serviceDeployWarning,
      athensSystemdState
    );

    await appendSessionLog(ip, token, serviceDeployWarning ? "create_server_completed_with_service_warning" : "create_server_completed", {
      remoteDir,
      version: versionRow.version,
      license_type: lt,
      deploy_mode: effectiveDeployMode,
      server_status: serverStatus,
      ...(serviceDeployWarning ? { service_deploy_warning: serviceDeployWarning } : {}),
    });

    const [[expireRows]] = await dbPool.execute("SELECT expire_date FROM license WHERE uuid = ? LIMIT 1", [rowUuid]);
    const expireDateIso = licenseExpireToIso(expireRows?.expire_date);

    const defaultDescription = "Server artifacts uploaded and remote deploy.sh completed";
    const responsePayload = {
      description: serviceDeployWarning || defaultDescription,
      license_type: lt,
      version: versionRow.version,
      expire_date: expireDateIso,
      server_status: serverStatus,
      uuid: rowUuid,
      machine_id: machineId,
      remote_dir: remoteDir,
      deploy_mode: effectiveDeployMode,
      remote_deploy_flag: remoteDeployFlag,
      uploaded_files: [
        "license.tar.gz",
        path.basename(productPath),
        path.basename(DEPLOY_SH),
        path.basename(GEODB_MMDB_TAR_GZ),
      ],
      dorian_version: {
        version: versionRow.version,
        full_name: versionRow.full_name,
        uuid: versionRow.uuid,
      },
      ...(serviceDeployWarning ? { service_deploy_warning: serviceDeployWarning } : {}),
    };
    deployLog("info", reqId, "create_server success; sending 200 JSON", {
      keys: Object.keys(responsePayload),
      machine_id: machineId,
      version: versionRow.version,
      expire_date: expireDateIso || null,
      server_status: serverStatus,
      dorian_version: versionRow.version,
    });
    return res.status(200).json(responsePayload);
  } catch (error) {
    await appendSessionLog(ip, token, "create_server_failed", { error: error.message, code: error.code });
    deployLog("error", reqId, `create_server failed: ${error.message}`, {
      code: error.code,
      stack: error.stack ? String(error.stack).split("\n").slice(0, 4).join(" | ") : undefined,
    });
    if (error.code === "NO_VERSION") {
      return res.status(500).json({
        code: 5000,
        description: error.message,
      });
    }
    return res.status(500).json({
      code: 5000,
      description: "create_server failed",
      error: error.message,
    });
  } finally {
    if (workDir) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

app.use("/docs", swaggerUi.serve, swaggerUi.setup(apiSpec));

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`deploy_license API running on port ${PORT}`);
});
