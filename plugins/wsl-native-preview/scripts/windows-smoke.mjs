import { ContextStore, WslPreviewBridge } from "../src/core.mjs";

function argumentsByName(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key ?? "end"}.`);
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

const options = argumentsByName(process.argv.slice(2));
for (const required of ["distro", "workspace-root", "path", "windows-baseline"]) {
  if (!options[required]) throw new Error(`Missing --${required}.`);
}

const contextStore = new ContextStore();
const bridge = new WslPreviewBridge({ contextStore });
const sessionId = `windows-smoke-${process.pid}-${Date.now()}`;
const cwd = `\\\\wsl.localhost\\${options.distro}${options["workspace-root"].replaceAll("/", "\\")}`;
const bound = contextStore.createOrRefresh({ sessionId, cwd });
if (!bound.supported) throw new Error(bound.reason);

let prepared = null;
let release = null;
try {
  const before = bridge.status({ contextId: bound.context.contextId });
  prepared = bridge.preparePreviewArtifacts({
    contextId: bound.context.contextId,
    paths: [options.path],
  });
  const windowsBaseline = bridge.resolveWindowsPath(options["windows-baseline"]);
  if (prepared.mapping.created && prepared.mapping.drive) {
    release = bridge.releasePreviewMappingForContext({ contextId: bound.context.contextId });
  }
  process.stdout.write(`${JSON.stringify({ before, context: contextStore.publicContext(bound.context.contextId), prepared, windowsBaseline, release }, null, 2)}\n`);
} finally {
  if (prepared?.mapping.created && prepared.mapping.drive && !release) {
    bridge.releasePreviewMappingForContext({ contextId: bound.context.contextId });
  }
  contextStore.endSession(sessionId);
}
