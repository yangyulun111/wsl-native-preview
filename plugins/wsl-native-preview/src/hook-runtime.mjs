import { ContextStore, parseWslUncCwd, publicError } from "./core.mjs";

const MAX_HOOK_INPUT_BYTES = 1024 * 1024;
const MAX_STOP_PATHS = 20;

function maskCode(message) {
  return message
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/~~~[\s\S]*?~~~/gu, " ")
    .replace(/(`+)[^\r\n]*?\1/gu, " ");
}

export function extractMarkdownLinkTargets(message) {
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

export function unresolvedWorkspaceLinks(message, context) {
  const result = [];
  const seen = new Set();
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

export function runSessionStartHook(input, options = {}) {
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
    "Render each returned previewMarkdown verbatim. Do not pass distro or workspaceRoot, do not transform Windows-native links, and do not claim that conversion is guaranteed when the tool is unavailable or denied.",
  ].join("\n");
  return {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  };
}

export function runStopHook(input, options = {}) {
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
      "If the tool is unavailable or permission is denied, state that limitation and finish without retrying again.",
    ].join(" "),
  };
}

export function runSessionEndHook(input, options = {}) {
  if (typeof input?.session_id !== "string") return quietContinue();
  const store = options.contextStore ?? new ContextStore(options);
  store.endSession(input.session_id);
  return quietContinue();
}

export function runHook(event, input, options = {}) {
  try {
    if (event === "session-start") return runSessionStartHook(input, options);
    if (event === "stop") return runStopHook(input, options);
    if (event === "session-end") return runSessionEndHook(input, options);
    return quietContinue();
  } catch (error) {
    if (options.onError) options.onError(publicError(error));
    return quietContinue();
  }
}

export async function readHookInput(stream = process.stdin) {
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
