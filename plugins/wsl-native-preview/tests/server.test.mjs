import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function startClient(t) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wsl-native-preview-bundle-mcp-"));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const child = spawn(process.execPath, ["dist/server.mjs"], {
    cwd: pluginRoot,
    env: { ...process.env, WSL_NATIVE_PREVIEW_DATA_ROOT: dataRoot },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (!child.killed) child.kill();
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let buffer = "";
  const messages = [];
  const waiters = new Map();
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const parsed = JSON.parse(line);
      messages.push(parsed);
      if (parsed.id !== undefined && waiters.has(parsed.id)) {
        waiters.get(parsed.id)(parsed);
        waiters.delete(parsed.id);
      }
    }
  });
  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  function response(id) {
    const existing = messages.find((message) => message.id === id);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`Timed out waiting for MCP response ${id}. stderr: ${stderr}`));
      }, 5000);
      waiters.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }
  return { child, send, response, messages, stderr: () => stderr };
}

test("bundled MCP negotiates 2025-06-18 and exposes only context-bound tools", async (t) => {
  const client = startClient(t);
  client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "wsl-native-preview-test", version: "1.0.0" },
    },
  });
  const initialized = await client.response(1);
  assert.equal(initialized.error, undefined);
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
  assert.equal(typeof initialized.result.capabilities.resources, "object");
  client.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  client.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listed = await client.response(2);
  assert.equal(listed.error, undefined);
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name).sort(),
    ["prepare_preview_artifacts", "release_preview_mapping", "wsl_preview_status"],
  );
  client.send({ jsonrpc: "2.0", id: 3, method: "resources/list", params: {} });
  const resources = await client.response(3);
  assert.equal(resources.result.resources.some((resource) => resource.uri === "wsl-preview://about"), true);
  assert.equal(client.messages.every((message) => message.jsonrpc === "2.0"), true);
  assert.equal(client.stderr(), "");
});

test("bundled MCP and hook configuration use plugin-relative files", () => {
  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8"));
  assert.deepEqual(config.mcpServers["wsl-native-preview"], {
    command: "node",
    args: ["./dist/server.mjs"],
    cwd: ".",
  });
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  assert.equal(hooks.hooks.SessionStart[0].hooks[0].command.includes("${PLUGIN_ROOT}/dist/hook.mjs"), true);
  assert.equal(hooks.hooks.Stop[0].hooks[0].command.includes(" stop"), true);
  assert.equal(fs.statSync(path.join(pluginRoot, "dist", "server.mjs")).isFile(), true);
  assert.equal(fs.statSync(path.join(pluginRoot, "dist", "hook.mjs")).isFile(), true);
});

test("bundled SessionStart hook emits JSON and writes only to its data root", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "wsl-native-preview-bundle-hook-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const environment = { ...process.env, PLUGIN_DATA: temporary };
  delete environment.WSL_NATIVE_PREVIEW_DATA_ROOT;
  delete environment.CLAUDE_PLUGIN_DATA;
  const child = spawnSync(process.execPath, ["dist/hook.mjs", "session-start"], {
    cwd: pluginRoot,
    env: environment,
    input: JSON.stringify({
      session_id: "bundle-thread",
      cwd: "\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\repo",
      source: "startup",
    }),
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /prepare_preview_artifacts/u);
  assert.equal(fs.existsSync(path.join(temporary, "contexts")), true);
  assert.equal(fs.existsSync(path.join(pluginRoot, "contexts")), false);
});
