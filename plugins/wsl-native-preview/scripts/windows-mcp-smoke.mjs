import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContextStore, WslPreviewBridge } from "../src/core.mjs";

function argumentsByName(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key ?? "end"}.`);
    const name = key.slice(2);
    if (name === "path") {
      parsed.path = [...(Array.isArray(parsed.path) ? parsed.path : []), value];
    } else {
      parsed[name] = value;
    }
  }
  return parsed;
}

const options = argumentsByName(process.argv.slice(2));
for (const required of ["distro", "workspace-root"]) {
  if (!options[required]) throw new Error(`Missing --${required}.`);
}
const paths = options["paths-json"] ? JSON.parse(options["paths-json"]) : (options.path ?? []);
if (!Array.isArray(paths) || paths.length === 0 || paths.some((entry) => typeof entry !== "string" || !entry)) {
  throw new Error("Provide --path or a non-empty JSON string array with --paths-json.");
}

const contextStore = new ContextStore();
const bridge = new WslPreviewBridge({ contextStore });
const sessionId = `windows-mcp-smoke-${process.pid}-${Date.now()}`;
const cwd = `\\\\wsl.localhost\\${options.distro}${options["workspace-root"].replaceAll("/", "\\")}`;
const bound = contextStore.createOrRefresh({ sessionId, cwd });
if (!bound.supported) throw new Error(bound.reason);

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, [path.join(pluginRoot, "dist", "server.mjs")], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");

let buffer = "";
let stderr = "";
let nextId = 1;
const waiters = new Map();
const received = [];

child.stderr.on("data", (chunk) => { stderr += chunk; });
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      throw new Error(`Non-JSON MCP stdout: ${line}`);
    }
    received.push(message);
    const waiter = waiters.get(message.id);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiters.delete(message.id);
      waiter.resolve(message);
    }
  }
});

function request(method, params = {}) {
  const id = nextId;
  nextId += 1;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`Timed out waiting for ${method}. stderr: ${stderr}`));
    }, 10000);
    waiters.set(id, { resolve, timer });
  });
}

function notify(method, params = {}) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function toolValue(response) {
  if (response.error) throw new Error(JSON.stringify(response.error));
  if (response.result?.isError) throw new Error(response.result.content?.[0]?.text ?? "MCP tool failed.");
  return JSON.parse(response.result.content[0].text);
}

let prepared = null;
let released = null;
let resourceLinks = [];
let resourceReads = [];
try {
  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "windows-mcp-smoke", version: "2.0.0" },
  });
  if (initialized.result?.protocolVersion !== "2025-06-18") throw new Error("Protocol negotiation mismatch.");
  notify("notifications/initialized");
  const tools = await request("tools/list");
  const status = toolValue(await request("tools/call", {
    name: "wsl_preview_status",
    arguments: { contextId: bound.context.contextId },
  }));
  const preparedResponse = await request("tools/call", {
    name: "prepare_preview_artifacts",
    arguments: {
      contextId: bound.context.contextId,
      paths,
      probeResourceLinks: options["probe-resource-links"] === "true",
    },
  });
  prepared = toolValue(preparedResponse);
  resourceLinks = (preparedResponse.result?.content ?? []).filter((entry) => entry.type === "resource_link");
  for (const link of resourceLinks) {
    const response = await request("resources/read", { uri: link.uri });
    if (response.error) {
      resourceReads.push({ uri: link.uri, success: false, error: response.error });
      continue;
    }
    const content = response.result?.contents?.[0] ?? {};
    resourceReads.push({
      uri: link.uri,
      success: true,
      mimeType: content.mimeType ?? null,
      transportField: typeof content.text === "string" ? "text" : "blob",
      encodedLength: typeof content.text === "string" ? content.text.length : (content.blob?.length ?? 0),
    });
  }
  if (prepared.mapping.created && prepared.mapping.drive) {
    released = toolValue(await request("tools/call", {
      name: "release_preview_mapping",
      arguments: { contextId: bound.context.contextId },
    }));
  }
  process.stdout.write(`${JSON.stringify({
    protocolVersion: initialized.result.protocolVersion,
    tools: tools.result.tools.map((tool) => tool.name),
    statusReadOnly: status.readOnly,
    context: status.context,
    prepared,
    resourceLinks: resourceLinks.map((entry) => ({ name: entry.name, title: entry.title, uri: entry.uri, mimeType: entry.mimeType })),
    resourceReads,
    released,
    stdoutMessagesAreJsonRpc: received.every((message) => message.jsonrpc === "2.0"),
    stderr,
  }, null, 2)}\n`);
} finally {
  if (prepared?.mapping.created && prepared.mapping.drive && !released) {
    bridge.releasePreviewMappingForContext({ contextId: bound.context.contextId });
  }
  contextStore.endSession(sessionId);
  child.stdin.end();
  child.kill();
}
