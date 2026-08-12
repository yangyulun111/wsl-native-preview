import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BridgeError,
  CANDIDATE_DRIVES,
  ContextStore,
  MAPPING_BACKEND,
  MAPPING_TYPE,
  STATE_SCHEMA_VERSION,
  SUPPORT_LEVEL,
  WslPreviewBridge,
  defaultDataRoot,
  dosDeviceTargetToPath,
  linuxPathToFileUri,
  linuxPathToPreviewUri,
  parseDosDeviceJson,
  parseSubstOutput,
  parseWslDistroList,
  parseWslUncCwd,
  windowsPathToFileUri,
} from "../src/core.mjs";

function commandResult(status = 0, stdout = "", stderr = "") {
  return { status, stdout: Buffer.from(stdout, "utf8"), stderr: Buffer.from(stderr, "utf8") };
}

test("data root prefers explicit overrides and Codex plugin data directories", () => {
  assert.equal(defaultDataRoot({
    WSL_NATIVE_PREVIEW_DATA_ROOT: "X:\\explicit",
    PLUGIN_DATA: "X:\\plugin-data",
    LOCALAPPDATA: "X:\\local",
  }), "X:\\explicit");
  assert.equal(defaultDataRoot({
    PLUGIN_DATA: "X:\\plugin-data",
    LOCALAPPDATA: "X:\\local",
  }), "X:\\plugin-data");
  assert.equal(defaultDataRoot({
    CLAUDE_PLUGIN_DATA: "X:\\compat-data",
    LOCALAPPDATA: "X:\\local",
  }), "X:\\compat-data");
  assert.equal(
    defaultDataRoot({ LOCALAPPDATA: "X:\\local" }),
    "X:\\local\\OpenAI\\Codex\\plugins\\wsl-native-preview",
  );
  assert.equal(
    defaultDataRoot({}),
    path.join(os.homedir(), ".local", "state", "OpenAI", "Codex", "plugins", "wsl-native-preview"),
  );
});

class MockRunner {
  constructor() {
    this.calls = [];
    this.distros = ["Ubuntu-22.04", "Ubuntu Test"];
    this.substs = new Map();
    this.logical = new Set(["C:", "D:"]);
    this.network = new Set();
    this.persistent = new Set();
    this.realpaths = new Map();
    this.regularFiles = new Set();
    this.queryDosDeviceFails = false;
  }

  substOutput() {
    return [...this.substs.entries()].map(([drive, target]) => {
      const displayed = target.startsWith("\\\\") ? `UNC\\${target.slice(2)}` : target;
      return `${drive}\\: => ${displayed}`;
    }).join("\r\n");
  }

  dosDeviceOutput() {
    const result = {};
    for (const drive of CANDIDATE_DRIVES) {
      const subst = this.substs.get(drive);
      if (subst?.startsWith("\\\\")) result[drive] = `\\??\\UNC\\${subst.slice(2)}`;
      else if (subst) result[drive] = `\\??\\${subst}`;
      else if (this.logical.has(drive)) result[drive] = `\\Device\\HarddiskVolume${drive[0]}`;
      else if (this.network.has(drive)) result[drive] = `\\Device\\Mup\\server\\share`;
      else result[drive] = null;
    }
    return JSON.stringify(result);
  }

  wslWindowsPath(distro, linuxPath) {
    if (linuxPath === "/mnt/c") return "C:\\";
    if (linuxPath.startsWith("/mnt/c/")) return `C:\\${linuxPath.slice(7).replaceAll("/", "\\")}`;
    return `\\\\wsl.localhost\\${distro}${linuxPath.replaceAll("/", "\\")}`;
  }

  run(file, args = []) {
    this.calls.push({ file, args: [...args] });
    if (file === "wsl.exe" && args[0] === "-l") {
      return { status: 0, stdout: Buffer.from(`${this.distros.join("\r\n")}\r\n`, "utf16le"), stderr: Buffer.alloc(0) };
    }
    if (file === "wsl.exe" && args[0] === "-d") {
      const distro = args[1];
      const executable = args[3];
      if (executable === "realpath") {
        const requested = args.at(-1);
        const resolved = this.realpaths.get(requested) ?? path.posix.normalize(requested);
        return commandResult(0, `${resolved}\n`);
      }
      if (executable === "wslpath") {
        const linuxPath = args.at(-1);
        return commandResult(0, `${this.wslWindowsPath(distro, linuxPath)}\n`);
      }
      if (executable === "test") {
        return commandResult(this.regularFiles.has(args.at(-1)) ? 0 : 1);
      }
    }
    if (file === "powershell.exe") {
      return this.queryDosDeviceFails ? commandResult(1, "", "QueryDosDevice failed") : commandResult(0, this.dosDeviceOutput());
    }
    if (file === "subst.exe") {
      if (args.length === 0) return commandResult(0, this.substOutput());
      const drive = args[0].toUpperCase();
      if (args[1]?.toUpperCase() === "/D") {
        if (!this.substs.has(drive)) return commandResult(1, "", "not found");
        this.substs.delete(drive);
        return commandResult();
      }
      if (this.logical.has(drive) || this.substs.has(drive) || this.network.has(drive) || this.persistent.has(drive)) {
        return commandResult(1, "", "occupied");
      }
      this.substs.set(drive, args[1]);
      return commandResult();
    }
    if (file === "fsutil.exe") {
      return commandResult(0, `Drives: ${[...this.logical].map((drive) => `${drive}\\`).join(" ")}`);
    }
    if (file === "mountvol.exe") return commandResult(0, "");
    if (file === "net.exe") {
      return commandResult(0, [...this.network].map((drive) => `OK ${drive} \\server\\share`).join("\r\n"));
    }
    if (file === "reg.exe") {
      const match = /HKCU\\Network\\([A-Z])/u.exec(args[1] ?? "");
      return commandResult(match && this.persistent.has(`${match[1]}:`) ? 0 : 1);
    }
    return commandResult(1, "", `unexpected command: ${file} ${args.join(" ")}`);
  }
}

function testFs(options = {}) {
  const wrapper = Object.create(fs);
  const shouldMock = (requested) => (
    /^[WVUTS]:\\/iu.test(requested)
    || /^\\\\wsl(?:\.localhost|\$)\\/iu.test(requested)
    || options.nativePaths?.has(requested)
  );
  wrapper.statSync = (requested) => {
    if (shouldMock(requested)) {
      return { isFile: () => true, size: options.size ?? 128, mtimeMs: Date.now() };
    }
    return fs.statSync(requested);
  };
  wrapper.readFileSync = (requested, encoding) => {
    if (shouldMock(requested)) {
      const value = options.fileContent ?? Buffer.from("preview-data", "utf8");
      return encoding ? value.toString(encoding) : value;
    }
    return fs.readFileSync(requested, encoding);
  };
  return wrapper;
}

function makeFixture(t, options = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "wsl-native-preview-test-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const runner = options.runner ?? new MockRunner();
  const now = options.now ?? (() => new Date("2026-08-11T00:00:00.000Z"));
  const fileSystem = options.fs ?? testFs();
  const contextStore = new ContextStore({
    fs: fileSystem,
    dataRoot: temporary,
    now,
    randomBytes: options.randomBytes,
    ttlMs: options.ttlMs,
  });
  const bridge = new WslPreviewBridge({
    platform: "win32",
    runner,
    fs: fileSystem,
    dataRoot: temporary,
    contextStore,
    now,
    lockTimeoutMs: options.lockTimeoutMs,
    lockRetryMs: options.lockRetryMs,
  });
  const session = contextStore.createOrRefresh({
    sessionId: "session-1",
    cwd: options.cwd ?? "\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\repo",
  });
  return { bridge, runner, contextStore, context: session.context, temporary };
}

test("parses UTF-16LE WSL distro names and trusted UNC workspace roots", () => {
  const data = Buffer.from("Ubuntu-22.04\r\n发行版 Test\r\n", "utf16le");
  assert.deepEqual(parseWslDistroList(data), ["Ubuntu-22.04", "发行版 Test"]);
  assert.deepEqual(parseWslUncCwd("\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\repo"), {
    distro: "Ubuntu-22.04",
    workspaceRoot: "/home/user/repo",
    rawCwd: "\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\repo",
  });
  assert.equal(parseWslUncCwd("/home/user/repo"), null);
  assert.equal(parseWslUncCwd("C:\\repo"), null);
  assert.equal(parseWslUncCwd("\\\\wsl.localhost\\Ubuntu-22.04"), null);
});

test("parses SUBST diagnostics and authoritative QueryDosDevice targets", () => {
  const mappings = parseSubstOutput("W:\\: => UNC\\wsl.localhost\\Ubuntu-22.04\\home\\user\r\nV:\\: => C:\\Preview Root\r\n");
  assert.equal(mappings.get("W:"), "\\\\wsl.localhost\\Ubuntu-22.04\\home\\user");
  assert.equal(mappings.get("V:"), "C:\\Preview Root");
  assert.equal(dosDeviceTargetToPath("\\??\\UNC\\wsl.localhost\\Ubuntu-22.04\\home\\user"), "\\\\wsl.localhost\\Ubuntu-22.04\\home\\user");
  const parsed = parseDosDeviceJson(JSON.stringify({ "W:": "\\??\\UNC\\wsl.localhost\\Ubuntu-22.04\\home\\user", "V:": null }));
  assert.equal(parsed.paths.get("W:"), "\\\\wsl.localhost\\Ubuntu-22.04\\home\\user");
  assert.equal(parsed.paths.get("V:"), null);
});

test("encodes Windows, Linux, and custom preview URIs", () => {
  assert.equal(windowsPathToFileUri("W:\\目录 with space\\a#b(1)%.md"), "file:///W:/%E7%9B%AE%E5%BD%95%20with%20space/a%23b(1)%25.md");
  assert.equal(linuxPathToFileUri("/home/user/目录 #(1)%.md"), "file:///home/user/%E7%9B%AE%E5%BD%95%20%23(1)%25.md");
  assert.equal(linuxPathToPreviewUri("Ubuntu-22.04", "/home/user/a b(1).md"), "wsl-preview:///Ubuntu-22.04/home/user/a%20b(1).md");
});

test("context is a short-lived workspace bearer and refreshes only for the same session cwd", (t) => {
  const { contextStore, context } = makeFixture(t);
  assert.match(context.contextId, /^[A-Za-z0-9_-]{43}$/u);
  const refreshed = contextStore.createOrRefresh({
    sessionId: "session-1",
    cwd: "\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\repo",
    source: "resume",
  });
  assert.equal(refreshed.context.contextId, context.contextId);
  assert.equal(refreshed.refreshed, true);
  assert.equal(contextStore.publicContext(context.contextId).capabilityType, "short-lived-workspace-bearer");
});

test("expired and forged contexts are rejected", (t) => {
  let clock = new Date("2026-08-11T00:00:00.000Z");
  const { contextStore, context } = makeFixture(t, { now: () => clock, ttlMs: 1000 });
  clock = new Date("2026-08-11T00:00:02.000Z");
  assert.throws(() => contextStore.get(context.contextId), (error) => error.code === "CONTEXT_EXPIRED");
  assert.throws(() => contextStore.get("A".repeat(43)), (error) => error.code === "CONTEXT_NOT_FOUND");
});

test("status is read-only, uses QueryDosDevice, and does not start a distro", (t) => {
  const { bridge, runner, context } = makeFixture(t);
  const status = bridge.status({ contextId: context.contextId });
  assert.equal(status.supported, true);
  assert.equal(status.mappingType, MAPPING_TYPE);
  assert.equal(status.backend, MAPPING_BACKEND);
  assert.equal(status.supportLevel, SUPPORT_LEVEL);
  assert.equal(status.dosDeviceInspectionAvailable, true);
  assert.equal(runner.calls.some((call) => call.file === "wsl.exe" && call.args.includes("-d")), false);
  assert.equal(runner.calls.some((call) => call.file === "subst.exe" && call.args.length > 0), false);
});

test("ensure preserves occupied W and creates a verified workspace-scoped alias on V", (t) => {
  const runner = new MockRunner();
  runner.substs.set("W:", "\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\other-repo");
  const { bridge } = makeFixture(t, { runner });
  const first = bridge.ensurePreviewMapping({ distro: "Ubuntu-22.04", workspaceRoot: "/home/user/repo" });
  assert.equal(first.drive, "V:");
  assert.equal(first.created, true);
  assert.equal(first.mappingType, MAPPING_TYPE);
  assert.equal(first.backend, MAPPING_BACKEND);
  assert.equal(runner.substs.get("W:"), "\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\other-repo");
  const second = bridge.ensurePreviewMapping({ distro: "Ubuntu-22.04", workspaceRoot: "/home/user/repo" });
  assert.equal(second.drive, "V:");
  assert.equal(second.created, false);
  assert.equal(second.createdByPlugin, true);
});

test("QueryDosDevice failure blocks creation instead of trusting localized diagnostics", (t) => {
  const runner = new MockRunner();
  runner.queryDosDeviceFails = true;
  const { bridge } = makeFixture(t, { runner });
  assert.throws(
    () => bridge.ensurePreviewMapping({ distro: "Ubuntu-22.04", workspaceRoot: "/home/user/repo" }),
    (error) => error instanceof BridgeError && error.code === "DOS_DEVICE_INSPECTION_UNAVAILABLE",
  );
  assert.equal(runner.substs.size, 0);
});

test("all occupied candidates fail without overwriting", (t) => {
  const runner = new MockRunner();
  for (const drive of CANDIDATE_DRIVES) runner.logical.add(drive);
  const { bridge } = makeFixture(t, { runner });
  assert.throws(
    () => bridge.ensurePreviewMapping({ distro: "Ubuntu-22.04", workspaceRoot: "/home/user/repo" }),
    (error) => error instanceof BridgeError && error.code === "NO_DRIVE_AVAILABLE",
  );
});

test("/mnt/c trusted workspace stays Windows-native", (t) => {
  const { bridge, runner, context } = makeFixture(t, {
    cwd: "\\\\wsl.localhost\\Ubuntu-22.04\\mnt\\c\\repo",
    fs: testFs({ nativePaths: new Set(["C:\\repo\\output.md"]) }),
  });
  const file = "/mnt/c/repo/output.md";
  runner.regularFiles.add(file);
  const result = bridge.preparePreviewArtifacts({ contextId: context.contextId, paths: [file] });
  assert.equal(result.mapping.mappingType, "windows-native");
  assert.equal(result.mapping.drive, null);
  assert.equal(runner.substs.size, 0);
});

test("prepare uses only hook-bound workspace and emits visible Linux source", (t) => {
  const { bridge, runner, context } = makeFixture(t);
  const longSegment = "a".repeat(280);
  const file = `/home/user/repo/目录 with space/${longSegment} #(1)%.md`;
  runner.regularFiles.add(file);
  const result = bridge.preparePreviewArtifacts({ contextId: context.contextId, paths: [file] });
  assert.equal(result.artifacts[0].windowsPath.startsWith("W:\\"), true);
  assert.match(result.artifacts[0].previewMarkdown, /^\[[^\]]+\]\(<W:\//u);
  assert.equal(result.artifacts[0].previewMarkdown.includes(file), true);
  assert.equal(result.artifacts[0].presentationMode, "drive-link-with-source");
  assert.equal(result.artifacts[0].sourceCopiedByPlugin, false);
});

test("prepare rejects parent traversal and canonical symlink escape", (t) => {
  const { bridge, runner, context } = makeFixture(t);
  assert.throws(
    () => bridge.preparePreviewArtifacts({ contextId: context.contextId, paths: ["/home/user/repo/../secret.md"] }),
    (error) => error.code === "INVALID_LINUX_PATH",
  );
  const link = "/home/user/repo/link.md";
  runner.realpaths.set(link, "/home/user/outside.md");
  assert.throws(
    () => bridge.preparePreviewArtifacts({ contextId: context.contextId, paths: [link] }),
    (error) => error.code === "PATH_OUTSIDE_WORKSPACE",
  );
});

test("resource probe returns three variants and bounded resource reads", (t) => {
  const { bridge, runner, context } = makeFixture(t, { fs: testFs({ fileContent: Buffer.from("hello") }) });
  const file = "/home/user/repo/report.md";
  runner.regularFiles.add(file);
  const prepared = bridge.preparePreviewArtifacts({ contextId: context.contextId, paths: [file], probeResourceLinks: true });
  const candidates = prepared.artifacts[0].resourceLinkCandidates;
  assert.deepEqual(candidates.map((entry) => entry.variant), ["windows-file-uri", "linux-file-uri", "wsl-preview-uri"]);
  const read = bridge.readPreparedResource({
    contextId: context.contextId,
    canonicalFile: file,
    uri: candidates[2].uri,
    mimeType: "text/markdown",
  });
  assert.equal(read.contents[0].text, "hello");
  assert.equal(read.contentTransport, "mcp-resource-read");
});

test("resource reads reject files larger than 32 MiB while leaving the drive-link fallback available", (t) => {
  const { bridge, runner, context } = makeFixture(t, { fs: testFs({ size: (32 * 1024 * 1024) + 1 }) });
  const file = "/home/user/repo/large.pdf";
  runner.regularFiles.add(file);
  const prepared = bridge.preparePreviewArtifacts({ contextId: context.contextId, paths: [file], probeResourceLinks: true });
  assert.match(prepared.artifacts[0].previewMarkdown, /^\[[^\]]+\]\(<W:\//u);
  assert.throws(
    () => bridge.readPreparedResource({
      contextId: context.contextId,
      canonicalFile: file,
      uri: prepared.artifacts[0].resourceLinkCandidates[0].uri,
      mimeType: "application/pdf",
    }),
    (error) => error.code === "RESOURCE_TOO_LARGE" && error.details.limit === 32 * 1024 * 1024,
  );
});

test("v1 ownership migrates only when QueryDosDevice exactly matches", (t) => {
  const runner = new MockRunner();
  const { bridge, temporary } = makeFixture(t, { runner });
  const target = "\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\repo";
  runner.substs.set("W:", target);
  fs.writeFileSync(path.join(temporary, "state.json"), JSON.stringify({
    schemaVersion: 1,
    mappings: {
      "W:": { drive: "W:", target, createdByPlugin: true, mappingType: "subst-drive-alias" },
      "V:": { drive: "V:", target: "C:\\Changed", createdByPlugin: true, mappingType: "subst-drive-alias" },
    },
  }));
  assert.equal(bridge.status().stateMigrationPending, true);
  bridge.ensurePreviewMapping({ distro: "Ubuntu-22.04", workspaceRoot: "/home/user/repo" });
  const state = JSON.parse(fs.readFileSync(path.join(temporary, "state.json"), "utf8"));
  assert.equal(state.schemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(state.mappings["W:"].mappingType, MAPPING_TYPE);
  assert.equal(state.mappings["V:"].migrationStatus, "unverified-v1-preserved");
});

test("release by context removes only the exact plugin-owned alias", (t) => {
  const { bridge, runner, context } = makeFixture(t);
  runner.regularFiles.add("/home/user/repo/file.md");
  bridge.preparePreviewArtifacts({ contextId: context.contextId, paths: ["/home/user/repo/file.md"] });
  const released = bridge.releasePreviewMappingForContext({ contextId: context.contextId });
  assert.equal(released.mappingRemoved, true);
  assert.equal(runner.substs.has("W:"), false);
});

test("release clears stale state without deleting a changed target", (t) => {
  const { bridge, runner } = makeFixture(t);
  const ensured = bridge.ensurePreviewMapping({ distro: "Ubuntu-22.04", workspaceRoot: "/home/user/repo" });
  runner.substs.set(ensured.drive, "C:\\SomeoneElse");
  const released = bridge.releasePreviewMapping({ drive: ensured.drive });
  assert.equal(released.mappingRemoved, false);
  assert.equal(released.stateCleared, true);
  assert.equal(runner.substs.get(ensured.drive), "C:\\SomeoneElse");
});

test("live state lock prevents concurrent mapping mutation", (t) => {
  const { bridge } = makeFixture(t, { lockTimeoutMs: 5, lockRetryMs: 1 });
  fs.writeFileSync(bridge.lockFile, "other-process\n");
  assert.throws(
    () => bridge.ensurePreviewMapping({ distro: "Ubuntu-22.04", workspaceRoot: "/home/user/repo" }),
    (error) => error.code === "STATE_BUSY",
  );
});
