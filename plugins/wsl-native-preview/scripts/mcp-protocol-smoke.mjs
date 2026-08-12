import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wsl-native-preview-protocol-"));
const child = spawn(process.execPath, [path.join(pluginRoot, "dist", "server.mjs")], {
  cwd: pluginRoot,
  env: { ...process.env, WSL_NATIVE_PREVIEW_DATA_ROOT: dataRoot },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
let stdoutBuffer = "";
let stderr = "";
let nextId = 1;
const messages = [];
const waiters = new Map();

child.stderr.on("data", (chunk) => { stderr += chunk; });
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  while (stdoutBuffer.includes("\n")) {
    const newline = stdoutBuffer.indexOf("\n");
    const line = stdoutBuffer.slice(0, newline).trim();
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      throw new Error(`MCP stdout contained a non-JSON line: ${line}`);
    }
    messages.push(message);
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
    }, 10_000);
    waiters.set(id, { resolve, reject, timer });
  });
}

try {
  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "wsl-native-preview-protocol-smoke", version: "0.2.0" },
  });
  if (initialized.error || initialized.result?.protocolVersion !== "2025-06-18") {
    throw new Error(`MCP initialization failed: ${JSON.stringify(initialized)}`);
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  const tools = await request("tools/list");
  const names = (tools.result?.tools ?? []).map((tool) => tool.name).sort();
  const expected = ["prepare_preview_artifacts", "release_preview_mapping", "wsl_preview_status"];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected MCP tools: ${JSON.stringify(names)}`);
  }
  const resources = await request("resources/list");
  if (!(resources.result?.resources ?? []).some((resource) => resource.uri === "wsl-preview://about")) {
    throw new Error("MCP about resource is missing.");
  }
  if (!messages.every((message) => message.jsonrpc === "2.0")) {
    throw new Error("MCP stdout contained a non-JSON-RPC message.");
  }
  if (stderr !== "") throw new Error(`MCP stderr was not empty: ${stderr}`);
  process.stdout.write(`${JSON.stringify({
    protocolVersion: initialized.result.protocolVersion,
    tools: names,
    stdoutPurity: true,
    stderrEmpty: true,
  })}\n`);
} finally {
  child.stdin.end();
  child.kill();
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
