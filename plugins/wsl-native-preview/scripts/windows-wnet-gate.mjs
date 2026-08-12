import path from "node:path";
import { spawnSync } from "node:child_process";
import { CANDIDATE_DRIVES } from "../src/core.mjs";

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
for (const required of ["distro", "workspace-root", "path"]) {
  if (!options[required]) throw new Error(`Missing --${required}.`);
}
if (/[\\/\u0000\r\n]/u.test(options.distro)) throw new Error("Invalid distro name.");
if (!options["workspace-root"].startsWith("/") || options["workspace-root"].split("/").includes("..")) {
  throw new Error("workspace-root must be an absolute Linux path without '..'.");
}
const relative = path.posix.relative(options["workspace-root"], options.path);
if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
  throw new Error("path must stay within workspace-root.");
}
const drive = (options.drive ?? "V:").toUpperCase();
if (!CANDIDATE_DRIVES.includes(drive)) throw new Error(`drive must be one of ${CANDIDATE_DRIVES.join(", ")}.`);
const remote = `\\\\wsl.localhost\\${options.distro}${options["workspace-root"].replaceAll("/", "\\")}`;
const relativeWindows = relative.replaceAll("/", "\\");

const script = String.raw`
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CodexWslPreviewWNetGate {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct NETRESOURCE {
    public int dwScope;
    public int dwType;
    public int dwDisplayType;
    public int dwUsage;
    public string lpLocalName;
    public string lpRemoteName;
    public string lpComment;
    public string lpProvider;
  }
  [DllImport("mpr.dll", CharSet = CharSet.Unicode)]
  public static extern int WNetAddConnection2W(ref NETRESOURCE resource, string password, string username, int flags);
  [DllImport("mpr.dll", CharSet = CharSet.Unicode)]
  public static extern int WNetCancelConnection2W(string name, int flags, bool force);
}
'@
$drive = $env:WSL_PREVIEW_GATE_DRIVE
$remote = $env:WSL_PREVIEW_GATE_REMOTE
$relative = $env:WSL_PREVIEW_GATE_RELATIVE
if (Get-PSDrive -Name $drive.Substring(0, 1) -ErrorAction SilentlyContinue) {
  @{ passed = $false; reason = 'drive-occupied'; drive = $drive; remote = $remote; remaining = $true } | ConvertTo-Json -Compress
  exit 0
}
$resource = New-Object CodexWslPreviewWNetGate+NETRESOURCE
$resource.dwType = 1
$resource.lpLocalName = $drive
$resource.lpRemoteName = $remote
$addCode = -1
$readable = $false
$cancelCode = $null
try {
  $addCode = [CodexWslPreviewWNetGate]::WNetAddConnection2W([ref]$resource, $null, $null, 0)
  if ($addCode -eq 0) {
    $readable = Test-Path -LiteralPath ($drive + '\' + $relative) -PathType Leaf
  }
} finally {
  if ($addCode -eq 0) {
    $cancelCode = [CodexWslPreviewWNetGate]::WNetCancelConnection2W($drive, 0, $true)
  }
}
$remaining = [bool](Get-PSDrive -Name $drive.Substring(0, 1) -ErrorAction SilentlyContinue)
@{
  passed = ($addCode -eq 0 -and $readable -and $cancelCode -eq 0 -and -not $remaining)
  drive = $drive
  remote = $remote
  addCode = $addCode
  readable = $readable
  cancelCode = $cancelCode
  remaining = $remaining
  desktopPreviewRequired = $true
} | ConvertTo-Json -Compress
`;

const encoded = Buffer.from(script, "utf16le").toString("base64");
const child = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
  encoding: "utf8",
  windowsHide: true,
  env: {
    ...process.env,
    WSL_PREVIEW_GATE_DRIVE: drive,
    WSL_PREVIEW_GATE_REMOTE: remote,
    WSL_PREVIEW_GATE_RELATIVE: relativeWindows,
  },
});
if (child.error) throw child.error;
if (child.status !== 0) throw new Error(child.stderr || `PowerShell exited ${child.status}.`);
const result = JSON.parse(child.stdout.trim());
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
