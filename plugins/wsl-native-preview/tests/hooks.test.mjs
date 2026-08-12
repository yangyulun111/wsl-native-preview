import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContextStore } from "../src/core.mjs";
import {
  extractMarkdownLinkTargets,
  runSessionEndHook,
  runSessionStartHook,
  runStopHook,
  unresolvedWorkspaceLinks,
} from "../src/hook-runtime.mjs";

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "wsl-native-preview-hook-test-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const contextStore = new ContextStore({
    dataRoot: temporary,
    now: () => new Date("2026-08-11T00:00:00.000Z"),
    randomBytes: () => Buffer.alloc(32, 7),
  });
  return { temporary, contextStore };
}

test("SessionStart binds a context from trusted UNC cwd without creating a mapping", (t) => {
  const { contextStore } = fixture(t);
  const result = runSessionStartHook({
    session_id: "thread-1",
    cwd: "\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\repo",
    source: "startup",
  }, { contextStore });
  assert.equal(result.continue, true);
  assert.match(result.hookSpecificOutput.additionalContext, /prepare_preview_artifacts/u);
  const context = contextStore.getForSession("thread-1");
  assert.equal(context.workspaceRoot, "/home/user/repo");
  assert.equal(context.distro, "Ubuntu-22.04");
});

test("SessionStart stays silent for Windows and WSL-agent cwd values", (t) => {
  const { contextStore } = fixture(t);
  assert.deepEqual(runSessionStartHook({ session_id: "a", cwd: "C:\\repo" }, { contextStore }), {
    continue: true,
    suppressOutput: true,
  });
  assert.deepEqual(runSessionStartHook({ session_id: "b", cwd: "/home/user/repo" }, { contextStore }), {
    continue: true,
    suppressOutput: true,
  });
});

test("Markdown scanner ignores code and plain paths", () => {
  const message = [
    "plain /home/user/repo/plain.md",
    "`[inline](/home/user/repo/inline.md)`",
    "```markdown\n[fenced](/home/user/repo/fenced.md)\n```",
    "[real](</home/user/repo/a b.md>)",
    "![image](/home/user/repo/figure.png)",
  ].join("\n");
  assert.deepEqual(extractMarkdownLinkTargets(message), ["/home/user/repo/a b.md", "/home/user/repo/figure.png"]);
});

test("Stop blocks once for raw workspace links and supplies context-only tool arguments", (t) => {
  const { contextStore } = fixture(t);
  runSessionStartHook({
    session_id: "thread-1",
    cwd: "\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\repo",
    source: "startup",
  }, { contextStore });
  const context = contextStore.getForSession("thread-1");
  const message = [
    "[inside](</home/user/repo/output.md>)",
    "[outside](</home/user/other/secret.md>)",
    "[windows](<C:/repo/local.md>)",
  ].join("\n");
  assert.deepEqual(unresolvedWorkspaceLinks(message, context), ["/home/user/repo/output.md"]);
  const result = runStopHook({
    session_id: "thread-1",
    last_assistant_message: message,
    stop_hook_active: false,
  }, { contextStore });
  assert.equal(result.decision, "block");
  assert.match(result.reason, /prepare_preview_artifacts/u);
  assert.match(result.reason, new RegExp(context.contextId, "u"));
  assert.equal(result.reason.includes("workspaceRoot"), false);
  assert.deepEqual(runStopHook({
    session_id: "thread-1",
    last_assistant_message: message,
    stop_hook_active: true,
  }, { contextStore }), { continue: true, suppressOutput: true });
});

test("Stop accepts converted drive links with visible original path", (t) => {
  const { contextStore } = fixture(t);
  runSessionStartHook({
    session_id: "thread-1",
    cwd: "\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\repo",
  }, { contextStore });
  const result = runStopHook({
    session_id: "thread-1",
    last_assistant_message: "[output.md](<V:/output.md>) · `/home/user/repo/output.md`",
    stop_hook_active: false,
  }, { contextStore });
  assert.deepEqual(result, { continue: true, suppressOutput: true });
});

test("SessionEnd removes only ephemeral context state", (t) => {
  const { contextStore } = fixture(t);
  runSessionStartHook({
    session_id: "thread-1",
    cwd: "\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\repo",
  }, { contextStore });
  const contextId = contextStore.getForSession("thread-1").contextId;
  runSessionEndHook({ session_id: "thread-1" }, { contextStore });
  assert.equal(contextStore.getForSession("thread-1"), null);
  assert.throws(() => contextStore.get(contextId), (error) => error.code === "CONTEXT_NOT_FOUND");
});
