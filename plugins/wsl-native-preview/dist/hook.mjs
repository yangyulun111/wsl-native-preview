// src/core.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
var CANDIDATE_DRIVES = Object.freeze(["W:", "V:", "U:", "T:", "S:"]);
var CONTEXT_SCHEMA_VERSION = 1;
var CONTEXT_TTL_MS = 24 * 60 * 60 * 1e3;
var MAX_RESOURCE_BYTES = 32 * 1024 * 1024;
var MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
var CONTEXT_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
var BridgeError = class extends Error {
  constructor(code, message, details = void 0) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }
};
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
  fileSystem.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}
`, { encoding: "utf8", mode: 384 });
  fileSystem.renameSync(temporary, filePath);
}
function safeUnlink(fileSystem, filePath) {
  try {
    fileSystem.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
function defaultDataRoot(environment = process.env) {
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
      "wsl-native-preview"
    );
  }
  return path.join(os.homedir(), ".local", "state", "OpenAI", "Codex", "plugins", "wsl-native-preview");
}
function parseWslUncCwd(cwd) {
  if (typeof cwd !== "string" || /[\u0000\r\n]/u.test(cwd)) return null;
  const match = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/iu.exec(cwd.replaceAll("/", "\\"));
  if (!match) return null;
  const distro = match[1];
  const segments = (match[2] ?? "").split("\\").filter(Boolean);
  if (segments.length === 0 || segments.includes("..") || segments.includes(".")) return null;
  const workspaceRoot = `/${segments.join("/")}`;
  return { distro, workspaceRoot, rawCwd: cwd };
}
var ContextStore = class {
  constructor(options = {}) {
    this.fs = options.fs ?? fs;
    this.dataRoot = options.dataRoot ?? defaultDataRoot(options.environment);
    this.now = options.now ?? (() => /* @__PURE__ */ new Date());
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
        error: error.message
      });
    }
  }
  createOrRefresh({ sessionId, cwd, source = "startup" }) {
    const parsed = parseWslUncCwd(cwd);
    if (!parsed) {
      return {
        supported: false,
        reason: "Automatic preview requires a Windows-native agent opened on a WSL UNC workspace below the distro root."
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
          lastStartSource: source
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
      lastStartSource: source
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
      lastHookAt: this.now().toISOString()
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
      capabilityType: "short-lived-workspace-bearer"
    };
  }
};
function publicError(error) {
  if (error instanceof BridgeError) {
    return { error: { code: error.code, message: error.message, details: error.details } };
  }
  return { error: { code: "INTERNAL_ERROR", message: error?.message ?? String(error) } };
}

// src/hook-runtime.mjs
var MAX_HOOK_INPUT_BYTES = 1024 * 1024;
var MAX_STOP_PATHS = 20;
function maskCode(message) {
  return message.replace(/```[\s\S]*?```/gu, " ").replace(/~~~[\s\S]*?~~~/gu, " ").replace(/(`+)[^\r\n]*?\1/gu, " ");
}
function extractMarkdownLinkTargets(message) {
  if (typeof message !== "string" || message.length === 0) return [];
  const visible = maskCode(message);
  const targets = [];
  const pattern = /!?\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|([^\s)]+))(?:\s+["'][^\r\n)]*["'])?\s*\)/gu;
  for (const match of visible.matchAll(pattern)) {
    targets.push(match[1] ?? match[2]);
  }
  return targets;
}
function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function targetToLinuxPath(target, context) {
  if (target.startsWith("file:///")) {
    try {
      const parsed = new URL(target);
      if (parsed.protocol === "file:" && parsed.pathname.startsWith("/")) return decodePath(parsed.pathname);
    } catch {
      return null;
    }
  }
  if (target.startsWith("/")) return decodePath(target);
  const unc = parseWslUncCwd(target.replaceAll("/", "\\"));
  if (unc && unc.distro.toLowerCase() === context.distro.toLowerCase()) return unc.workspaceRoot;
  return null;
}
function withinWorkspace(root, candidate) {
  if (!candidate?.startsWith("/") || candidate.split("/").includes("..")) return false;
  return candidate === root || candidate.startsWith(`${root}/`);
}
function unresolvedWorkspaceLinks(message, context) {
  const result = [];
  const seen = /* @__PURE__ */ new Set();
  for (const target of extractMarkdownLinkTargets(message)) {
    const linuxPath = targetToLinuxPath(target, context);
    if (!withinWorkspace(context.workspaceRoot, linuxPath) || seen.has(linuxPath)) continue;
    seen.add(linuxPath);
    result.push(linuxPath);
  }
  return result;
}
function quietContinue() {
  return { continue: true, suppressOutput: true };
}
function runSessionStartHook(input, options = {}) {
  const store = options.contextStore ?? new ContextStore(options);
  const sessionId = input?.session_id;
  const cwd = input?.cwd;
  if (typeof sessionId !== "string" || typeof cwd !== "string") return quietContinue();
  const result = store.createOrRefresh({ sessionId, cwd, source: input.source ?? "startup" });
  if (!result.supported) return quietContinue();
  const { context } = result;
  const additionalContext = [
    "WSL Native Preview is active for this Windows-native UNC workspace.",
    `Trusted preview contextId: ${context.contextId}`,
    `Trusted workspace: ${context.workspaceRoot} in distro ${context.distro}.`,
    "Before a final response contains clickable links to files inside this workspace, call prepare_preview_artifacts once with this contextId and the exact absolute Linux paths.",
    "Render each returned previewMarkdown verbatim. Do not pass distro or workspaceRoot, do not transform Windows-native links, and do not claim that conversion is guaranteed when the tool is unavailable or denied."
  ].join("\n");
  return {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext
    }
  };
}
function runStopHook(input, options = {}) {
  if (input?.stop_hook_active === true) return quietContinue();
  if (typeof input?.session_id !== "string" || typeof input?.last_assistant_message !== "string") {
    return quietContinue();
  }
  const store = options.contextStore ?? new ContextStore(options);
  const context = store.getForSession(input.session_id);
  if (!context) return quietContinue();
  const paths = unresolvedWorkspaceLinks(input.last_assistant_message, context).slice(0, MAX_STOP_PATHS);
  store.heartbeat(context.contextId, "Stop");
  if (paths.length === 0) return quietContinue();
  const call = JSON.stringify({ contextId: context.contextId, paths });
  return {
    decision: "block",
    reason: [
      "The previous answer contains clickable raw WSL file links inside the trusted workspace.",
      `Call prepare_preview_artifacts with ${call}.`,
      "Then answer once with the returned previewMarkdown strings, preserving the visible original Linux paths.",
      "If the tool is unavailable or permission is denied, state that limitation and finish without retrying again."
    ].join(" ")
  };
}
function runSessionEndHook(input, options = {}) {
  if (typeof input?.session_id !== "string") return quietContinue();
  const store = options.contextStore ?? new ContextStore(options);
  store.endSession(input.session_id);
  return quietContinue();
}
function runHook(event2, input, options = {}) {
  try {
    if (event2 === "session-start") return runSessionStartHook(input, options);
    if (event2 === "stop") return runStopHook(input, options);
    if (event2 === "session-end") return runSessionEndHook(input, options);
    return quietContinue();
  } catch (error) {
    if (options.onError) options.onError(publicError(error));
    return quietContinue();
  }
}
async function readHookInput(stream = process.stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_HOOK_INPUT_BYTES) throw new Error("Hook input exceeds 1 MiB.");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

// src/hook.mjs
var event = process.argv[2] ?? "";
try {
  const input = await readHookInput();
  const output = runHook(event, input, {
    onError: (error) => process.stderr.write(`wsl-native-preview hook warning: ${JSON.stringify(error)}
`)
  });
  process.stdout.write(`${JSON.stringify(output)}
`);
} catch (error) {
  process.stderr.write(`wsl-native-preview hook failed safely: ${error?.message ?? String(error)}
`);
  process.stdout.write(`${JSON.stringify({ continue: true, suppressOutput: true })}
`);
}
