import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const CANDIDATE_DRIVES = Object.freeze(["W:", "V:", "U:", "T:", "S:"]);
export const STATE_SCHEMA_VERSION = 2;
export const CONTEXT_SCHEMA_VERSION = 1;
export const CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;
export const MAPPING_TYPE = "dos-device-alias";
export const MAPPING_BACKEND = "subst.exe";
export const SUPPORT_LEVEL = "target-build-gated";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const CONTEXT_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export class BridgeError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }
}

export class ProcessRunner {
  run(file, args = []) {
    const result = spawnSync(file, args, {
      encoding: null,
      windowsHide: true,
      maxBuffer: MAX_OUTPUT_BYTES,
      shell: false,
    });
    if (result.error) {
      return {
        status: -1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(result.error.message, "utf8"),
      };
    }
    return {
      status: result.status ?? -1,
      stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""),
      stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? ""),
    };
  }
}

export function decodeCommandOutput(value) {
  if (typeof value === "string") return value;
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value ?? "");
  if (buffer.length >= 2) {
    let nulCount = 0;
    for (let index = 1; index < Math.min(buffer.length, 256); index += 2) {
      if (buffer[index] === 0) nulCount += 1;
    }
    if (nulCount >= 2) return buffer.toString("utf16le");
  }
  return buffer.toString("utf8");
}

function outputText(result) {
  return decodeCommandOutput(result.stdout).replaceAll("\u0000", "").trim();
}

function errorText(result) {
  return decodeCommandOutput(result.stderr).replaceAll("\u0000", "").trim();
}

function runChecked(runner, file, args, code, message) {
  const result = runner.run(file, args);
  if (result.status !== 0) {
    throw new BridgeError(code, message, {
      executable: file,
      exitCode: result.status,
      stderr: errorText(result),
    });
  }
  return outputText(result);
}

function assertString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new BridgeError("INVALID_ARGUMENT", `${field} must be a non-empty string.`);
  }
  if (/[\u0000\r\n]/u.test(value)) {
    throw new BridgeError("INVALID_ARGUMENT", `${field} contains a forbidden control character.`);
  }
  return value;
}

function pathApiFor(value) {
  return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value) ? path.win32 : path;
}

function joinPath(root, ...segments) {
  return pathApiFor(root).join(root, ...segments);
}

function atomicWriteJson(fileSystem, filePath, value) {
  const api = pathApiFor(filePath);
  const directory = api.dirname(filePath);
  fileSystem.mkdirSync(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fileSystem.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fileSystem.renameSync(temporary, filePath);
}

function safeUnlink(fileSystem, filePath) {
  try {
    fileSystem.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function normalizeDrive(value) {
  const drive = assertString(value, "drive").toUpperCase();
  const normalized = drive.endsWith(":") ? drive : `${drive}:`;
  if (!/^[A-Z]:$/u.test(normalized)) {
    throw new BridgeError("INVALID_DRIVE", "drive must be a single Windows drive letter.");
  }
  return normalized;
}

function normalizeTarget(value) {
  let target = assertString(value, "target").replaceAll("/", "\\");
  while (target.length > 3 && target.endsWith("\\")) target = target.slice(0, -1);
  return target;
}

function windowsPathHasParentTraversal(value) {
  return value.split(/[\\/]+/u).includes("..");
}

function linuxPathHasParentTraversal(value) {
  return value.split("/").includes("..");
}

function isWindowsDrivePath(value) {
  return /^[A-Za-z]:[\\/]/u.test(value);
}

function isUncPath(value) {
  return /^\\\\[^\\]+\\[^\\]+/u.test(value);
}

function isLinuxAbsolute(value) {
  return value.startsWith("/");
}

function isWindowsNativePath(value) {
  return isWindowsDrivePath(value) || isUncPath(value);
}

function posixContains(root, candidate) {
  return candidate === root || candidate.startsWith(root === "/" ? "/" : `${root}/`);
}

function markdownTarget(windowsPath) {
  return windowsPath.replaceAll("\\", "/").replaceAll("<", "%3C").replaceAll(">", "%3E");
}

function escapeMarkdownLabel(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function inlineCode(value) {
  const runs = [...value.matchAll(/`+/gu)].map((match) => match[0].length);
  const fence = "`".repeat(Math.max(1, ...(runs.map((length) => length + 1))));
  const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
}

export function windowsPathToFileUri(windowsPath) {
  const value = assertString(windowsPath, "windowsPath").replaceAll("/", "\\");
  if (isWindowsDrivePath(value)) {
    const drive = value.slice(0, 2).toUpperCase();
    const segments = value.slice(3).split("\\").filter(Boolean).map(encodeURIComponent);
    return `file:///${drive}/${segments.join("/")}`;
  }
  if (isUncPath(value)) {
    const parts = value.slice(2).split("\\").filter(Boolean);
    const host = parts.shift();
    return `file://${host}/${parts.map(encodeURIComponent).join("/")}`;
  }
  throw new BridgeError("INVALID_WINDOWS_PATH", "Cannot create a file URI for a non-absolute Windows path.");
}

export function linuxPathToFileUri(linuxPath) {
  const value = assertString(linuxPath, "linuxPath");
  if (!isLinuxAbsolute(value)) throw new BridgeError("INVALID_LINUX_PATH", "linuxPath must be absolute.");
  return `file:///${value.slice(1).split("/").map(encodeURIComponent).join("/")}`;
}

export function linuxPathToPreviewUri(distro, linuxPath) {
  const exactDistro = assertString(distro, "distro");
  const value = assertString(linuxPath, "linuxPath");
  if (!isLinuxAbsolute(value)) throw new BridgeError("INVALID_LINUX_PATH", "linuxPath must be absolute.");
  return `wsl-preview:///${encodeURIComponent(exactDistro)}/${value.slice(1).split("/").map(encodeURIComponent).join("/")}`;
}

function previewResult(windowsPath, mappingType, extra = {}) {
  const normalized = windowsPath.replaceAll("/", "\\");
  const target = markdownTarget(normalized);
  return {
    windowsPath: normalized,
    markdownTarget: target,
    previewLink: `[Open WSL preview](<${target}>)`,
    fileUri: windowsPathToFileUri(normalized),
    linkType: "drive-markdown",
    sourceCopiedByPlugin: false,
    mappingType,
    ...extra,
  };
}

export function parseWslDistroList(value) {
  return decodeCommandOutput(value)
    .replaceAll("\u0000", "")
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseSubstOutput(value) {
  const mappings = new Map();
  const text = decodeCommandOutput(value).replaceAll("\u0000", "");
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const match = /^([A-Za-z]):\\:\s*=>\s*(.+)$/u.exec(line);
    if (!match) continue;
    const drive = `${match[1].toUpperCase()}:`;
    let target = match[2].trim();
    if (/^UNC\\/iu.test(target)) target = `\\\\${target.slice(4)}`;
    mappings.set(drive, normalizeTarget(target));
  }
  return mappings;
}

function parseDriveLetters(value) {
  const drives = new Set();
  const text = decodeCommandOutput(value).replaceAll("\u0000", "");
  for (const match of text.matchAll(/\b([A-Za-z]):(?:\\|\s)/gu)) {
    drives.add(`${match[1].toUpperCase()}:`);
  }
  return drives;
}

export function dosDeviceTargetToPath(target) {
  if (target === null || target === undefined || target === "") return null;
  const value = String(target);
  if (/^\\\?\?\\UNC\\/iu.test(value)) return normalizeTarget(`\\\\${value.slice(8)}`);
  if (/^\\\?\?\\[A-Za-z]:\\/u.test(value)) return normalizeTarget(value.slice(4));
  return value;
}

export function parseDosDeviceJson(value) {
  const text = decodeCommandOutput(value).replaceAll("\u0000", "").trim();
  const parsed = JSON.parse(text || "{}");
  const rawTargets = new Map();
  const paths = new Map();
  for (const [drive, target] of Object.entries(parsed)) {
    const exactDrive = normalizeDrive(drive);
    const rawTarget = typeof target === "string" && target.length > 0 ? target : null;
    rawTargets.set(exactDrive, rawTarget);
    paths.set(exactDrive, dosDeviceTargetToPath(rawTarget));
  }
  return { rawTargets, paths };
}

function queryDosDeviceScript(drives) {
  const names = drives.map((drive) => `'${normalizeDrive(drive)}'`).join(",");
  return `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CodexWslPreviewQueryDosDevice {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern uint QueryDosDevice(string name, StringBuilder target, int max);
}
'@
$result = [ordered]@{}
foreach ($name in @(${names})) {
  $buffer = New-Object System.Text.StringBuilder 32768
  $length = [CodexWslPreviewQueryDosDevice]::QueryDosDevice($name, $buffer, $buffer.Capacity)
  if ($length -gt 0) {
    $result[$name] = $buffer.ToString().Split([char]0)[0]
  } else {
    $result[$name] = $null
  }
}
$result | ConvertTo-Json -Compress
`;
}

export function defaultDataRoot(environment = process.env) {
  if (environment.WSL_NATIVE_PREVIEW_DATA_ROOT) return environment.WSL_NATIVE_PREVIEW_DATA_ROOT;
  if (environment.PLUGIN_DATA) return environment.PLUGIN_DATA;
  if (environment.CLAUDE_PLUGIN_DATA) return environment.CLAUDE_PLUGIN_DATA;
  if (environment.LOCALAPPDATA) {
    return path.win32.join(environment.LOCALAPPDATA, "OpenAI", "Codex", "plugins", "wsl-native-preview");
  }
  if (environment.USERPROFILE) {
    return path.win32.join(
      environment.USERPROFILE,
      "AppData",
      "Local",
      "OpenAI",
      "Codex",
      "plugins",
      "wsl-native-preview",
    );
  }
  return path.join(os.homedir(), ".local", "state", "OpenAI", "Codex", "plugins", "wsl-native-preview");
}

export function defaultStateFile(environment = process.env) {
  return joinPath(defaultDataRoot(environment), "state.json");
}

export function parseWslUncCwd(cwd) {
  if (typeof cwd !== "string" || /[\u0000\r\n]/u.test(cwd)) return null;
  const match = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/iu.exec(cwd.replaceAll("/", "\\"));
  if (!match) return null;
  const distro = match[1];
  const segments = (match[2] ?? "").split("\\").filter(Boolean);
  if (segments.length === 0 || segments.includes("..") || segments.includes(".")) return null;
  const workspaceRoot = `/${segments.join("/")}`;
  return { distro, workspaceRoot, rawCwd: cwd };
}

export class ContextStore {
  constructor(options = {}) {
    this.fs = options.fs ?? fs;
    this.dataRoot = options.dataRoot ?? defaultDataRoot(options.environment);
    this.now = options.now ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? crypto.randomBytes;
    this.ttlMs = options.ttlMs ?? CONTEXT_TTL_MS;
  }

  contextPath(contextId) {
    if (!CONTEXT_ID_PATTERN.test(contextId)) {
      throw new BridgeError("INVALID_CONTEXT", "contextId has an invalid format.");
    }
    return joinPath(this.dataRoot, "contexts", `${contextId}.json`);
  }

  sessionPath(sessionId) {
    const exactSession = assertString(sessionId, "session_id");
    const hash = crypto.createHash("sha256").update(exactSession, "utf8").digest("hex");
    return joinPath(this.dataRoot, "sessions", `${hash}.json`);
  }

  readJson(filePath) {
    try {
      return JSON.parse(this.fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new BridgeError("CONTEXT_STATE_INVALID", "Context state is unreadable or invalid JSON.", {
        filePath,
        error: error.message,
      });
    }
  }

  createOrRefresh({ sessionId, cwd, source = "startup" }) {
    const parsed = parseWslUncCwd(cwd);
    if (!parsed) {
      return {
        supported: false,
        reason: "Automatic preview requires a Windows-native agent opened on a WSL UNC workspace below the distro root.",
      };
    }
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
    const sessionFile = this.sessionPath(sessionId);
    const sessionHash = pathApiFor(sessionFile).basename(sessionFile, ".json");
    const priorIndex = this.readJson(sessionFile);
    if (priorIndex?.contextId && CONTEXT_ID_PATTERN.test(priorIndex.contextId)) {
      const prior = this.readJson(this.contextPath(priorIndex.contextId));
      if (prior?.rawCwd === cwd && prior?.sessionHash === sessionHash) {
        const refreshed = {
          ...prior,
          expiresAt,
          lastHookEvent: "SessionStart",
          lastHookAt: now.toISOString(),
          lastStartSource: source,
        };
        atomicWriteJson(this.fs, this.contextPath(prior.contextId), refreshed);
        atomicWriteJson(this.fs, sessionFile, { contextId: prior.contextId, expiresAt });
        return { supported: true, context: refreshed, refreshed: true };
      }
      safeUnlink(this.fs, this.contextPath(priorIndex.contextId));
    }
    const contextId = this.randomBytes(32).toString("base64url");
    const context = {
      schemaVersion: CONTEXT_SCHEMA_VERSION,
      contextId,
      sessionHash,
      distro: parsed.distro,
      workspaceRoot: parsed.workspaceRoot,
      rawCwd: parsed.rawCwd,
      createdAt: now.toISOString(),
      expiresAt,
      lastHookEvent: "SessionStart",
      lastHookAt: now.toISOString(),
      lastStartSource: source,
    };
    atomicWriteJson(this.fs, this.contextPath(contextId), context);
    atomicWriteJson(this.fs, sessionFile, { contextId, expiresAt });
    return { supported: true, context, refreshed: false };
  }

  get(contextId, { allowExpired = false } = {}) {
    const filePath = this.contextPath(assertString(contextId, "contextId"));
    const context = this.readJson(filePath);
    if (!context || context.schemaVersion !== CONTEXT_SCHEMA_VERSION || context.contextId !== contextId) {
      throw new BridgeError("CONTEXT_NOT_FOUND", "contextId is not registered for this plugin.");
    }
    const expires = Date.parse(context.expiresAt);
    if (!Number.isFinite(expires)) throw new BridgeError("CONTEXT_STATE_INVALID", "Context expiry is invalid.");
    if (!allowExpired && expires <= this.now().getTime()) {
      throw new BridgeError("CONTEXT_EXPIRED", "contextId has expired; start or resume the Codex task to refresh it.");
    }
    return context;
  }

  getForSession(sessionId) {
    const index = this.readJson(this.sessionPath(sessionId));
    if (!index?.contextId) return null;
    try {
      return this.get(index.contextId);
    } catch (error) {
      if (error instanceof BridgeError && ["CONTEXT_NOT_FOUND", "CONTEXT_EXPIRED"].includes(error.code)) return null;
      throw error;
    }
  }

  heartbeat(contextId, eventName) {
    const context = this.get(contextId);
    const updated = {
      ...context,
      lastHookEvent: assertString(eventName, "eventName"),
      lastHookAt: this.now().toISOString(),
    };
    atomicWriteJson(this.fs, this.contextPath(contextId), updated);
    return updated;
  }

  endSession(sessionId) {
    const sessionFile = this.sessionPath(sessionId);
    const index = this.readJson(sessionFile);
    if (index?.contextId && CONTEXT_ID_PATTERN.test(index.contextId)) {
      safeUnlink(this.fs, this.contextPath(index.contextId));
    }
    safeUnlink(this.fs, sessionFile);
    return { contextRemoved: Boolean(index?.contextId) };
  }

  publicContext(contextId) {
    const context = this.get(contextId);
    return {
      contextId: context.contextId,
      distro: context.distro,
      workspaceRoot: context.workspaceRoot,
      createdAt: context.createdAt,
      expiresAt: context.expiresAt,
      lastHookEvent: context.lastHookEvent ?? null,
      lastHookAt: context.lastHookAt ?? null,
      lastStartSource: context.lastStartSource ?? null,
      capabilityType: "short-lived-workspace-bearer",
    };
  }
}

function emptyState() {
  return { schemaVersion: STATE_SCHEMA_VERSION, mappings: {} };
}

function stateRecordIsOwned(record, target) {
  return Boolean(
    record
      && record.createdByPlugin === true
      && record.mappingType === MAPPING_TYPE
      && record.backend === MAPPING_BACKEND
      && normalizeTarget(record.target) === normalizeTarget(target),
  );
}

export function mimeTypeForPath(filePath) {
  const extension = path.posix.extname(filePath).toLowerCase();
  return ({
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
    ".csv": "text/csv",
    ".html": "text/html",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  })[extension] ?? "application/octet-stream";
}

function resourceLinkCandidates(distro, canonicalFile, resolved) {
  const name = path.posix.basename(canonicalFile);
  const common = {
    name,
    title: canonicalFile,
    description: `Original WSL path: ${canonicalFile}`,
    mimeType: mimeTypeForPath(canonicalFile),
  };
  return [
    { variant: "windows-file-uri", uri: resolved.fileUri, ...common },
    { variant: "linux-file-uri", uri: linuxPathToFileUri(canonicalFile), ...common },
    { variant: "wsl-preview-uri", uri: linuxPathToPreviewUri(distro, canonicalFile), ...common },
  ];
}

export class WslPreviewBridge {
  constructor(options = {}) {
    this.platform = options.platform ?? process.platform;
    this.runner = options.runner ?? new ProcessRunner();
    this.fs = options.fs ?? fs;
    this.dataRoot = options.dataRoot ?? defaultDataRoot(options.environment);
    this.stateFile = options.stateFile ?? joinPath(this.dataRoot, "state.json");
    this.lockFile = options.lockFile ?? `${this.stateFile}.lock`;
    this.contextStore = options.contextStore ?? new ContextStore({
      fs: this.fs,
      dataRoot: this.dataRoot,
      now: options.now,
    });
    this.candidateDrives = (options.candidateDrives ?? CANDIDATE_DRIVES).map(normalizeDrive);
    this.now = options.now ?? (() => new Date());
    this.lockTimeoutMs = options.lockTimeoutMs ?? 2000;
    this.lockRetryMs = options.lockRetryMs ?? 25;
    this.lockStaleMs = options.lockStaleMs ?? 30_000;
  }

  assertWindows() {
    if (this.platform !== "win32") {
      throw new BridgeError(
        "WINDOWS_NATIVE_REQUIRED",
        "This plugin must run under the Windows-native Codex Desktop agent.",
        { platform: this.platform },
      );
    }
  }

  sleep(milliseconds) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  }

  withStateLock(action) {
    const api = pathApiFor(this.lockFile);
    this.fs.mkdirSync(api.dirname(this.lockFile), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    let descriptor = null;
    while (descriptor === null) {
      try {
        descriptor = this.fs.openSync(this.lockFile, "wx", 0o600);
        this.fs.writeFileSync(descriptor, `${process.pid}\n`, "utf8");
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const stats = this.fs.statSync(this.lockFile);
          if (Date.now() - stats.mtimeMs > this.lockStaleMs) {
            safeUnlink(this.fs, this.lockFile);
            continue;
          }
        } catch (statError) {
          if (statError?.code === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() >= deadline) {
          throw new BridgeError("STATE_BUSY", "Another plugin process is updating preview mapping state.");
        }
        this.sleep(this.lockRetryMs);
      }
    }
    try {
      return action();
    } finally {
      this.fs.closeSync(descriptor);
      safeUnlink(this.fs, this.lockFile);
    }
  }

  readRawState() {
    if (!this.fs.existsSync(this.stateFile)) return emptyState();
    try {
      return JSON.parse(this.fs.readFileSync(this.stateFile, "utf8"));
    } catch (error) {
      throw new BridgeError("STATE_INVALID", "Plugin ownership state is unreadable or invalid JSON.", {
        stateFile: this.stateFile,
        error: error.message,
      });
    }
  }

  readState(snapshot = null) {
    const parsed = this.readRawState();
    if (parsed?.schemaVersion === STATE_SCHEMA_VERSION && typeof parsed.mappings === "object") {
      return { state: parsed, migrationPending: false };
    }
    if (parsed?.schemaVersion !== 1 || typeof parsed.mappings !== "object") {
      throw new BridgeError("STATE_INVALID", "Plugin ownership state has an unsupported schema.", {
        stateFile: this.stateFile,
        schemaVersion: parsed?.schemaVersion,
      });
    }
    const migrated = emptyState();
    for (const [driveKey, record] of Object.entries(parsed.mappings)) {
      const drive = normalizeDrive(driveKey);
      const actual = snapshot?.dosDevicePaths?.get(drive) ?? null;
      const expected = typeof record?.target === "string" ? normalizeTarget(record.target) : null;
      if (
        record?.createdByPlugin === true
        && record?.mappingType === "subst-drive-alias"
        && expected
        && actual === expected
      ) {
        migrated.mappings[drive] = {
          ...record,
          drive,
          mappingType: MAPPING_TYPE,
          backend: MAPPING_BACKEND,
          supportLevel: SUPPORT_LEVEL,
          migrationVerifiedAt: this.now().toISOString(),
        };
      } else {
        migrated.mappings[drive] = {
          ...record,
          drive,
          migrationStatus: "unverified-v1-preserved",
        };
      }
    }
    return { state: migrated, migrationPending: true };
  }

  writeState(state) {
    atomicWriteJson(this.fs, this.stateFile, { ...state, schemaVersion: STATE_SCHEMA_VERSION });
  }

  listDistros() {
    const result = this.runner.run("wsl.exe", ["-l", "-q"]);
    if (result.status !== 0) {
      throw new BridgeError("WSL_LIST_FAILED", "Unable to list WSL distributions without starting them.", {
        exitCode: result.status,
        stderr: errorText(result),
      });
    }
    return parseWslDistroList(result.stdout);
  }

  validateDistro(distro) {
    const requested = assertString(distro, "distro");
    const distros = this.listDistros();
    if (!distros.includes(requested)) {
      throw new BridgeError("DISTRO_NOT_FOUND", "distro must exactly match a name returned by wsl.exe -l -q.", {
        requested,
        available: distros,
      });
    }
    return requested;
  }

  runWslChecked(distro, executable, args, code, message) {
    return runChecked(
      this.runner,
      "wsl.exe",
      ["-d", distro, "--exec", executable, ...args],
      code,
      message,
    );
  }

  canonicalWorkspace(distro, workspaceRoot) {
    const requested = assertString(workspaceRoot, "workspaceRoot");
    if (!isLinuxAbsolute(requested) || linuxPathHasParentTraversal(requested) || requested === "/") {
      throw new BridgeError(
        "INVALID_WORKSPACE_ROOT",
        "workspaceRoot must be a non-root absolute Linux path without '..'.",
      );
    }
    const canonicalLinux = this.runWslChecked(
      distro,
      "realpath",
      ["--", requested],
      "WORKSPACE_REALPATH_FAILED",
      "Unable to canonicalize workspaceRoot in the requested distribution.",
    );
    if (canonicalLinux === "/") {
      throw new BridgeError("INVALID_WORKSPACE_ROOT", "The canonical workspace must not be the distro root.");
    }
    const windowsRoot = this.runWslChecked(
      distro,
      "wslpath",
      ["-w", canonicalLinux],
      "WORKSPACE_WSLPATH_FAILED",
      "Unable to convert workspaceRoot to a Windows path.",
    );
    if (!isWindowsNativePath(windowsRoot)) {
      throw new BridgeError("WORKSPACE_CONVERSION_INVALID", "wslpath returned a non-absolute Windows path.", {
        windowsRoot,
      });
    }
    return {
      requested,
      canonicalLinux,
      windowsRoot: normalizeTarget(windowsRoot),
      windowsNative: isWindowsDrivePath(windowsRoot),
    };
  }

  listSubstMappings() {
    const result = this.runner.run("subst.exe", []);
    if (result.status !== 0) return new Map();
    return parseSubstOutput(result.stdout);
  }

  queryDosDevices() {
    const script = queryDosDeviceScript(this.candidateDrives);
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const result = this.runner.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]);
    if (result.status !== 0) {
      return {
        available: false,
        rawTargets: new Map(),
        paths: new Map(),
        error: { exitCode: result.status, stderr: errorText(result) },
      };
    }
    try {
      const parsed = parseDosDeviceJson(result.stdout);
      return { available: true, ...parsed, error: null };
    } catch (error) {
      return {
        available: false,
        rawTargets: new Map(),
        paths: new Map(),
        error: { exitCode: result.status, stderr: error.message },
      };
    }
  }

  listLogicalDriveLetters() {
    const fsutil = this.runner.run("fsutil.exe", ["fsinfo", "drives"]);
    if (fsutil.status === 0) return parseDriveLetters(fsutil.stdout);
    const mountvol = this.runner.run("mountvol.exe", []);
    return mountvol.status === 0 ? parseDriveLetters(mountvol.stdout) : new Set();
  }

  listNetworkDriveLetters() {
    const result = this.runner.run("net.exe", ["use"]);
    return result.status === 0 ? parseDriveLetters(result.stdout) : new Set();
  }

  hasPersistentMapping(drive) {
    const letter = normalizeDrive(drive).slice(0, 1);
    return this.runner.run("reg.exe", ["query", `HKCU\\Network\\${letter}`, "/v", "RemotePath"]).status === 0;
  }

  driveSnapshot() {
    const substs = this.listSubstMappings();
    const dosDevices = this.queryDosDevices();
    const logical = this.listLogicalDriveLetters();
    const network = this.listNetworkDriveLetters();
    const statuses = {};
    for (const drive of this.candidateDrives) {
      const reasons = [];
      if (logical.has(drive)) reasons.push("logical-drive");
      if (substs.has(drive)) reasons.push("subst-diagnostic");
      if (network.has(drive)) reasons.push("network-mapping");
      if (this.hasPersistentMapping(drive)) reasons.push("persistent-network-profile");
      if (dosDevices.rawTargets.get(drive)) reasons.push("dos-device");
      statuses[drive] = {
        drive,
        occupied: reasons.length > 0,
        reasons,
        dosDeviceTarget: dosDevices.rawTargets.get(drive) ?? null,
        dosDevicePath: dosDevices.paths.get(drive) ?? null,
        substDiagnosticTarget: substs.get(drive) ?? null,
      };
    }
    return {
      substs,
      dosDevicesAvailable: dosDevices.available,
      dosDeviceError: dosDevices.error,
      dosDeviceTargets: dosDevices.rawTargets,
      dosDevicePaths: dosDevices.paths,
      statuses,
    };
  }

  status({ contextId } = {}) {
    if (this.platform !== "win32") {
      return {
        supported: false,
        platform: this.platform,
        reason: "Windows-native Codex Desktop is required.",
        stateFile: this.stateFile,
      };
    }
    const snapshot = this.driveSnapshot();
    let state = null;
    let stateError = null;
    let migrationPending = false;
    try {
      ({ state, migrationPending } = this.readState(snapshot));
    } catch (error) {
      stateError = publicError(error);
    }
    const ownedMappings = Object.values(state?.mappings ?? {}).map((record) => ({
      ...record,
      currentTarget: snapshot.dosDevicePaths.get(record.drive) ?? null,
      currentDosDeviceTarget: snapshot.dosDeviceTargets.get(record.drive) ?? null,
      ownershipValid: stateRecordIsOwned(record, snapshot.dosDevicePaths.get(record.drive) ?? "__missing__"),
    }));
    let context = null;
    let contextError = null;
    if (contextId) {
      try {
        context = this.contextStore.publicContext(contextId);
      } catch (error) {
        contextError = publicError(error);
      }
    }
    return {
      supported: true,
      platform: this.platform,
      readOnly: true,
      distros: this.listDistros(),
      stateFile: this.stateFile,
      stateSchemaVersion: STATE_SCHEMA_VERSION,
      stateMigrationPending: migrationPending,
      stateError,
      context,
      contextError,
      ownedMappings,
      drives: snapshot.statuses,
      dosDeviceInspectionAvailable: snapshot.dosDevicesAvailable,
      dosDeviceInspectionError: snapshot.dosDeviceError,
      sourceCopiedByPlugin: false,
      mappingType: MAPPING_TYPE,
      backend: MAPPING_BACKEND,
      supportLevel: SUPPORT_LEVEL,
      resourceLinkMode: "unverified-probe-only",
      automaticCorrection: "best-effort-when-hooks-are-trusted",
    };
  }

  ensurePreviewMapping({ distro, workspaceRoot }) {
    this.assertWindows();
    const exactDistro = this.validateDistro(distro);
    const workspace = this.canonicalWorkspace(exactDistro, workspaceRoot);
    if (workspace.windowsNative) {
      return {
        distro: exactDistro,
        workspaceRoot: workspace.canonicalLinux,
        windowsRoot: workspace.windowsRoot,
        drive: null,
        created: false,
        reused: true,
        createdByPlugin: false,
        mappingRequired: false,
        sourceCopiedByPlugin: false,
        mappingType: "windows-native",
        backend: null,
        supportLevel: "native",
      };
    }
    if (!isUncPath(workspace.windowsRoot)) {
      throw new BridgeError("WORKSPACE_NOT_MAPPABLE", "The canonical workspace is neither Windows-native nor UNC.");
    }
    return this.withStateLock(() => {
      let snapshot = this.driveSnapshot();
      if (!snapshot.dosDevicesAvailable) {
        throw new BridgeError(
          "DOS_DEVICE_INSPECTION_UNAVAILABLE",
          "QueryDosDeviceW inspection is required before creating or reusing a preview alias.",
          snapshot.dosDeviceError,
        );
      }
      const loaded = this.readState(snapshot);
      const state = loaded.state;
      for (const drive of this.candidateDrives) {
        if (snapshot.dosDevicePaths.get(drive) === workspace.windowsRoot) {
          if (loaded.migrationPending) this.writeState(state);
          return {
            distro: exactDistro,
            workspaceRoot: workspace.canonicalLinux,
            windowsRoot: workspace.windowsRoot,
            drive,
            created: false,
            reused: true,
            createdByPlugin: stateRecordIsOwned(state.mappings[drive], workspace.windowsRoot),
            mappingRequired: true,
            sourceCopiedByPlugin: false,
            mappingType: MAPPING_TYPE,
            backend: MAPPING_BACKEND,
            supportLevel: SUPPORT_LEVEL,
            dosDeviceTarget: snapshot.dosDeviceTargets.get(drive) ?? null,
          };
        }
      }

      const attempts = [];
      for (const drive of this.candidateDrives) {
        const driveStatus = snapshot.statuses[drive];
        if (driveStatus.occupied) {
          attempts.push({ drive, result: "occupied", reasons: driveStatus.reasons });
          continue;
        }
        const create = this.runner.run("subst.exe", [drive, workspace.windowsRoot]);
        snapshot = this.driveSnapshot();
        const currentTarget = snapshot.dosDevicePaths.get(drive) ?? null;
        if (snapshot.dosDevicesAvailable && currentTarget === workspace.windowsRoot) {
          const createdByPlugin = create.status === 0;
          if (createdByPlugin) {
            state.mappings[drive] = {
              drive,
              target: workspace.windowsRoot,
              dosDeviceTarget: snapshot.dosDeviceTargets.get(drive) ?? null,
              distro: exactDistro,
              workspaceRoot: workspace.canonicalLinux,
              createdByPlugin: true,
              createdAt: this.now().toISOString(),
              mappingType: MAPPING_TYPE,
              backend: MAPPING_BACKEND,
              supportLevel: SUPPORT_LEVEL,
            };
            this.writeState(state);
          } else if (loaded.migrationPending) {
            this.writeState(state);
          }
          return {
            distro: exactDistro,
            workspaceRoot: workspace.canonicalLinux,
            windowsRoot: workspace.windowsRoot,
            drive,
            created: createdByPlugin,
            reused: !createdByPlugin,
            createdByPlugin,
            mappingRequired: true,
            sourceCopiedByPlugin: false,
            mappingType: MAPPING_TYPE,
            backend: MAPPING_BACKEND,
            supportLevel: SUPPORT_LEVEL,
            dosDeviceTarget: snapshot.dosDeviceTargets.get(drive) ?? null,
          };
        }
        attempts.push({
          drive,
          result: "create-failed-or-raced",
          exitCode: create.status,
          currentTarget,
          dosDeviceInspectionAvailable: snapshot.dosDevicesAvailable,
          stderr: errorText(create),
        });
      }
      if (loaded.migrationPending) this.writeState(state);
      throw new BridgeError("NO_DRIVE_AVAILABLE", "No candidate drive could be safely mapped.", { attempts });
    });
  }

  resolveWindowsPath(inputPath) {
    const requested = assertString(inputPath, "path");
    if (!isWindowsNativePath(requested) || windowsPathHasParentTraversal(requested)) {
      throw new BridgeError("INVALID_WINDOWS_PATH", "Windows path must be absolute and must not contain '..'.");
    }
    const normalized = requested.replaceAll("/", "\\");
    let stats;
    try {
      stats = this.fs.statSync(normalized);
    } catch (error) {
      throw new BridgeError("FILE_NOT_FOUND", "Windows path is not readable.", { path: normalized, error: error.message });
    }
    if (!stats.isFile()) throw new BridgeError("NOT_A_FILE", "The requested Windows path is not a file.");
    return previewResult(normalized, "windows-native", { mappingRequired: false, backend: null, supportLevel: "native" });
  }

  resolveInWorkspace({ inputPath, distro, workspace, mapping }) {
    const requestedPath = assertString(inputPath, "path");
    if (!isLinuxAbsolute(requestedPath) || linuxPathHasParentTraversal(requestedPath)) {
      throw new BridgeError("INVALID_LINUX_PATH", "path must be an absolute Linux path without '..'.");
    }
    const canonicalFile = this.runWslChecked(
      distro,
      "realpath",
      ["--", requestedPath],
      "FILE_REALPATH_FAILED",
      "Unable to canonicalize the requested file.",
    );
    if (!posixContains(workspace.canonicalLinux, canonicalFile)) {
      throw new BridgeError("PATH_OUTSIDE_WORKSPACE", "The canonical file escapes the trusted workspace.", {
        workspaceRoot: workspace.canonicalLinux,
        canonicalFile,
      });
    }
    const fileCheck = this.runner.run("wsl.exe", ["-d", distro, "--exec", "test", "-f", canonicalFile]);
    if (fileCheck.status !== 0) throw new BridgeError("NOT_A_FILE", "The requested Linux path is not a regular file.");

    const windowsFile = this.runWslChecked(
      distro,
      "wslpath",
      ["-w", canonicalFile],
      "FILE_WSLPATH_FAILED",
      "Unable to convert the requested file to a Windows path.",
    );
    if (isWindowsDrivePath(windowsFile)) {
      return previewResult(windowsFile, "windows-native", {
        distro,
        workspaceRoot: workspace.canonicalLinux,
        canonicalFile,
        originalPath: requestedPath,
        mappingRequired: false,
        backend: null,
        supportLevel: "native",
      });
    }
    if (!mapping?.drive || mapping.windowsRoot !== workspace.windowsRoot) {
      throw new BridgeError("MAPPING_NOT_FOUND", "No verified mapping exists for the trusted workspace.");
    }
    const relative = path.posix.relative(workspace.canonicalLinux, canonicalFile);
    if (relative.startsWith("../") || relative === ".." || path.posix.isAbsolute(relative)) {
      throw new BridgeError("PATH_OUTSIDE_WORKSPACE", "Unable to form a safe workspace-relative path.");
    }
    const mappedPath = relative ? `${mapping.drive}\\${relative.replaceAll("/", "\\")}` : `${mapping.drive}\\`;
    let stats;
    try {
      stats = this.fs.statSync(mappedPath);
    } catch (error) {
      throw new BridgeError("MAPPED_FILE_NOT_READABLE", "The mapped Windows file is not readable.", {
        mappedPath,
        error: error.message,
      });
    }
    if (!stats.isFile()) throw new BridgeError("NOT_A_FILE", "The mapped path is not a file.");
    return previewResult(mappedPath, MAPPING_TYPE, {
      distro,
      workspaceRoot: workspace.canonicalLinux,
      canonicalFile,
      originalPath: requestedPath,
      drive: mapping.drive,
      mappingRequired: true,
      backend: MAPPING_BACKEND,
      supportLevel: SUPPORT_LEVEL,
      longPath: mappedPath.length >= 260,
    });
  }

  resolvePreviewLink({ path: inputPath, distro, workspaceRoot }) {
    this.assertWindows();
    const requestedPath = assertString(inputPath, "path");
    if (isWindowsNativePath(requestedPath)) return this.resolveWindowsPath(requestedPath);
    const exactDistro = this.validateDistro(distro);
    const workspace = this.canonicalWorkspace(exactDistro, workspaceRoot);
    let mapping = null;
    if (!workspace.windowsNative) {
      const snapshot = this.driveSnapshot();
      const found = this.candidateDrives.find((drive) => snapshot.dosDevicePaths.get(drive) === workspace.windowsRoot);
      if (found) mapping = { drive: found, windowsRoot: workspace.windowsRoot };
    }
    return this.resolveInWorkspace({ inputPath: requestedPath, distro: exactDistro, workspace, mapping });
  }

  preparePreviewArtifacts({ contextId, paths, probeResourceLinks = false }) {
    this.assertWindows();
    const context = this.contextStore.get(assertString(contextId, "contextId"));
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 20) {
      throw new BridgeError("INVALID_ARGUMENT", "paths must contain between 1 and 20 absolute Linux file paths.");
    }
    const exactDistro = this.validateDistro(context.distro);
    const workspace = this.canonicalWorkspace(exactDistro, context.workspaceRoot);
    const ensured = this.ensurePreviewMapping({ distro: exactDistro, workspaceRoot: workspace.canonicalLinux });
    const mapping = ensured.drive ? { drive: ensured.drive, windowsRoot: workspace.windowsRoot } : null;
    const artifacts = paths.map((inputPath) => {
      const resolved = this.resolveInWorkspace({ inputPath, distro: exactDistro, workspace, mapping });
      const label = escapeMarkdownLabel(path.posix.basename(resolved.canonicalFile));
      const clickable = `[${label}](<${resolved.markdownTarget}>)`;
      const result = {
        originalPath: inputPath,
        canonicalLinuxPath: resolved.canonicalFile,
        windowsPath: resolved.windowsPath,
        markdownTarget: resolved.markdownTarget,
        previewMarkdown: `${clickable} · ${inlineCode(resolved.canonicalFile)}`,
        linkType: "drive-markdown-with-visible-source",
        presentationMode: "drive-link-with-source",
        mimeType: mimeTypeForPath(resolved.canonicalFile),
        size: this.fs.statSync(resolved.windowsPath).size ?? null,
        sourceCopiedByPlugin: false,
        mappingType: resolved.mappingType,
        backend: resolved.backend,
        supportLevel: resolved.supportLevel,
      };
      if (probeResourceLinks) {
        result.resourceLinkCandidates = resourceLinkCandidates(exactDistro, resolved.canonicalFile, resolved);
      }
      return result;
    });
    this.contextStore.heartbeat(contextId, "PreparePreviewArtifacts");
    return {
      contextId,
      distro: exactDistro,
      workspaceRoot: workspace.canonicalLinux,
      mapping: {
        drive: ensured.drive,
        windowsRoot: ensured.windowsRoot,
        created: ensured.created,
        reused: ensured.reused,
        createdByPlugin: ensured.createdByPlugin,
        mappingType: ensured.mappingType,
        backend: ensured.backend,
        supportLevel: ensured.supportLevel,
        sourceCopiedByPlugin: false,
      },
      resourceLinkMode: probeResourceLinks ? "probe" : "disabled-until-gate-passes",
      artifacts,
    };
  }

  readPreparedResource({ contextId, canonicalFile, uri, mimeType }) {
    this.assertWindows();
    const context = this.contextStore.get(assertString(contextId, "contextId"));
    const exactDistro = this.validateDistro(context.distro);
    const workspace = this.canonicalWorkspace(exactDistro, context.workspaceRoot);
    const requested = assertString(canonicalFile, "canonicalFile");
    const current = this.runWslChecked(
      exactDistro,
      "realpath",
      ["--", requested],
      "RESOURCE_REALPATH_FAILED",
      "Unable to canonicalize the resource.",
    );
    if (current !== requested || !posixContains(workspace.canonicalLinux, current)) {
      throw new BridgeError("RESOURCE_CHANGED", "The registered resource changed or escaped the trusted workspace.");
    }
    const fileCheck = this.runner.run("wsl.exe", ["-d", exactDistro, "--exec", "test", "-f", current]);
    if (fileCheck.status !== 0) throw new BridgeError("NOT_A_FILE", "The resource is not a regular file.");
    const windowsFile = this.runWslChecked(
      exactDistro,
      "wslpath",
      ["-w", current],
      "RESOURCE_WSLPATH_FAILED",
      "Unable to convert the resource to a Windows path.",
    );
    const stats = this.fs.statSync(windowsFile);
    if (stats.size > MAX_RESOURCE_BYTES) {
      throw new BridgeError("RESOURCE_TOO_LARGE", "Resource exceeds the 32 MiB MCP read limit.", {
        size: stats.size,
        limit: MAX_RESOURCE_BYTES,
      });
    }
    const data = this.fs.readFileSync(windowsFile);
    const exactMime = mimeType || mimeTypeForPath(current);
    const resource = { uri, mimeType: exactMime };
    if (exactMime.startsWith("text/") || ["application/json", "image/svg+xml"].includes(exactMime)) {
      resource.text = data.toString("utf8");
    } else {
      resource.blob = data.toString("base64");
    }
    return {
      contents: [resource],
      sourceCopiedByPlugin: false,
      contentTransport: "mcp-resource-read",
    };
  }

  releasePreviewMapping({ drive }) {
    this.assertWindows();
    const exactDrive = normalizeDrive(drive);
    return this.withStateLock(() => {
      const snapshot = this.driveSnapshot();
      if (!snapshot.dosDevicesAvailable) {
        throw new BridgeError(
          "DOS_DEVICE_INSPECTION_UNAVAILABLE",
          "QueryDosDeviceW inspection is required before releasing a preview alias.",
          snapshot.dosDeviceError,
        );
      }
      const loaded = this.readState(snapshot);
      const state = loaded.state;
      const record = state.mappings[exactDrive];
      if (!record || !stateRecordIsOwned(record, record.target)) {
        if (loaded.migrationPending) this.writeState(state);
        return {
          drive: exactDrive,
          mappingRemoved: false,
          stateCleared: false,
          reason: "No verified plugin-owned v2 mapping is recorded for this drive.",
        };
      }
      const currentTarget = snapshot.dosDevicePaths.get(exactDrive) ?? null;
      const expectedTarget = normalizeTarget(record.target);
      if (currentTarget !== expectedTarget) {
        delete state.mappings[exactDrive];
        this.writeState(state);
        return {
          drive: exactDrive,
          mappingRemoved: false,
          stateCleared: true,
          reason: currentTarget === null ? "Mapping no longer exists." : "Drive target changed; it was not removed.",
          expectedTarget,
          currentTarget,
        };
      }
      const removal = this.runner.run("subst.exe", [exactDrive, "/D"]);
      const remainingSnapshot = this.driveSnapshot();
      const remaining = remainingSnapshot.dosDevicePaths.get(exactDrive) ?? null;
      if (removal.status !== 0 || !remainingSnapshot.dosDevicesAvailable || remaining !== null) {
        throw new BridgeError("RELEASE_FAILED", "The exact plugin-owned DOS device alias could not be removed.", {
          drive: exactDrive,
          expectedTarget,
          currentTarget: remaining,
          exitCode: removal.status,
          stderr: errorText(removal),
        });
      }
      delete state.mappings[exactDrive];
      this.writeState(state);
      return {
        drive: exactDrive,
        mappingRemoved: true,
        stateCleared: true,
        releasedTarget: expectedTarget,
        sourceCopiedByPlugin: false,
        mappingType: MAPPING_TYPE,
        backend: MAPPING_BACKEND,
        supportLevel: SUPPORT_LEVEL,
      };
    });
  }

  releasePreviewMappingForContext({ contextId }) {
    this.assertWindows();
    const context = this.contextStore.get(assertString(contextId, "contextId"));
    const exactDistro = this.validateDistro(context.distro);
    const workspace = this.canonicalWorkspace(exactDistro, context.workspaceRoot);
    if (workspace.windowsNative) {
      return { mappingRemoved: false, reason: "The trusted workspace is already Windows-native." };
    }
    const snapshot = this.driveSnapshot();
    const drive = this.candidateDrives.find((candidate) => snapshot.dosDevicePaths.get(candidate) === workspace.windowsRoot);
    if (!drive) return { mappingRemoved: false, reason: "No candidate drive maps to the trusted workspace." };
    return this.releasePreviewMapping({ drive });
  }
}

export function publicError(error) {
  if (error instanceof BridgeError) {
    return { error: { code: error.code, message: error.message, details: error.details } };
  }
  return { error: { code: "INTERNAL_ERROR", message: error?.message ?? String(error) } };
}
