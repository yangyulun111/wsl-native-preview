import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(pluginRoot, "..", "..");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function resolveInside(root, relativePath, label) {
  assert(typeof relativePath === "string" && relativePath.startsWith("./"), `${label} must start with './'.`);
  const resolved = path.resolve(root, relativePath);
  const prefix = `${path.resolve(root)}${path.sep}`;
  assert(resolved === path.resolve(root) || resolved.startsWith(prefix), `${label} escapes its root.`);
  return resolved;
}

const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const packagePath = path.join(pluginRoot, "package.json");
const lockPath = path.join(pluginRoot, "package-lock.json");
const mcpPath = path.join(pluginRoot, ".mcp.json");
const marketplacePath = path.join(repositoryRoot, ".agents", "plugins", "marketplace.json");
const manifest = readJson(manifestPath);
const packageJson = readJson(packagePath);
const lock = readJson(lockPath);
const mcp = readJson(mcpPath);
const marketplace = readJson(marketplacePath);

assert(manifest.name === "wsl-native-preview", "Unexpected plugin name.");
assert(manifest.version === "0.2.0", "Unexpected plugin version.");
assert(packageJson.version === manifest.version, "package.json version differs from the manifest.");
assert(lock.version === manifest.version, "package-lock.json version differs from the manifest.");
assert(lock.packages?.[""]?.version === manifest.version, "package-lock root version differs from the manifest.");
assert(packageJson.name === "@yangyulun111/wsl-native-preview", "Unexpected package name.");
assert(lock.name === packageJson.name && lock.packages?.[""]?.name === packageJson.name, "Lockfile package name differs.");
assert(manifest.mcpServers === "./.mcp.json", "Manifest must explicitly declare ./.mcp.json.");
assert(!Object.hasOwn(manifest, "hooks"), "Default hooks/hooks.json discovery must not be duplicated in the manifest.");
assert(fs.statSync(resolveInside(pluginRoot, manifest.skills, "manifest.skills")).isDirectory(), "Skills directory is missing.");
assert(fs.statSync(resolveInside(pluginRoot, manifest.mcpServers, "manifest.mcpServers")).isFile(), "MCP config is missing.");
assert(fs.statSync(path.join(pluginRoot, "hooks", "hooks.json")).isFile(), "Default hooks file is missing.");
assert(fs.statSync(path.join(pluginRoot, "dist", "server.mjs")).isFile(), "Bundled MCP server is missing.");
assert(fs.statSync(path.join(pluginRoot, "dist", "hook.mjs")).isFile(), "Bundled hook is missing.");

const server = mcp.mcpServers?.["wsl-native-preview"];
assert(server?.command === "node", "MCP command must be node.");
assert(JSON.stringify(server.args) === JSON.stringify(["./dist/server.mjs"]), "MCP args must reference the bundled server.");
assert(server.cwd === ".", "MCP cwd must remain plugin-relative.");

assert(marketplace.name === "yangyulun111-wsl-native-preview", "Unexpected marketplace name.");
assert(marketplace.interface?.displayName === "WSL Native Preview", "Unexpected marketplace display name.");
assert(Array.isArray(marketplace.plugins) && marketplace.plugins.length === 1, "Marketplace must contain exactly one plugin.");
const entry = marketplace.plugins[0];
assert(entry.name === manifest.name, "Marketplace plugin name differs from the manifest.");
assert(entry.source?.source === "local", "Marketplace plugin must use its Git snapshot-local source.");
const marketplacePlugin = resolveInside(repositoryRoot, entry.source?.path, "marketplace source.path");
assert(path.resolve(marketplacePlugin) === path.resolve(pluginRoot), "Marketplace source.path does not resolve to this plugin.");
assert(entry.policy?.installation === "AVAILABLE", "Marketplace installation policy must be AVAILABLE.");
assert(entry.policy?.authentication === "ON_INSTALL", "Marketplace authentication policy must be ON_INSTALL.");
assert(entry.category === "Productivity", "Marketplace category must be Productivity.");

const forbidden = [
  ["/home", "yyl"].join("/"),
  ["Admin", "istrator"].join(""),
  ["claude-code", "model-eval"].join("-"),
  ["mmad", "ontology-rag"].join("-"),
  ["config", "credentials", "local", "env"].join("."),
  ["API", "txt"].join("."),
  ["wsl-native-preview", "local"].join("-"),
];
const privatePatterns = [
  /S-1-\d+(?:-\d+){2,}/u,
  /contextId\s*[:=]\s*["']?[A-Za-z0-9_-]{43}["']?/u,
  /(?:sk-|Bearer\s+)[A-Za-z0-9._-]{12,}/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
];
const skipDirectories = new Set([".git", "node_modules", "coverage", ".pytest_cache"]);
const violations = [];

function scanTree(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (item.isDirectory() && skipDirectories.has(item.name)) continue;
    const absolute = path.join(directory, item.name);
    if (item.isDirectory()) {
      scanTree(absolute);
      continue;
    }
    if (!item.isFile() || item.name === "secret_scan.json") continue;
    const relative = path.relative(repositoryRoot, absolute).replaceAll(path.sep, "/");
    const text = fs.readFileSync(absolute, "utf8");
    for (const value of forbidden) {
      if (text.includes(value)) violations.push(`${relative}: forbidden local value`);
    }
    for (const pattern of privatePatterns) {
      if (pattern.test(text)) violations.push(`${relative}: possible private runtime or credential value`);
    }
  }
}

scanTree(repositoryRoot);
assert(violations.length === 0, `Sensitive-content validation failed:\n${violations.join("\n")}`);
process.stdout.write(`${JSON.stringify({
  plugin: `${manifest.name}@${manifest.version}`,
  marketplace: marketplace.name,
  mcpServer: "./.mcp.json",
  sensitiveContent: "clear",
})}\n`);
