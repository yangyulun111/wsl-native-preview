# WSL Native Preview plugin package

This directory contains the installable plugin distributed by the repository-level Git marketplace. For user-facing installation, architecture, security, lifecycle, and troubleshooting guidance, see the repository root README.

The certified target is Codex Desktop `26.803.5235.0`, Codex `0.147.0-alpha.6.5`, a Windows-native agent, and a non-elevated WSL UNC workspace. Normal drive-path Markdown passed the original built-in-preview gate; raw drive text and Markdown `file:///` links did not.

## Mapping backend

On the tested host, `WNetAddConnection2W`, `net use`, `New-SmbMapping`, and persistent `New-PSDrive` could not map the WSL workspace. `WNetAddConnection2W` returned Windows error `64` and left no drive behind.

The working backend remains `subst.exe`, but v0.2 describes it accurately as:

- `mappingType: "dos-device-alias"`
- `backend: "subst.exe"`
- `supportLevel: "target-build-gated"`

`QueryDosDeviceW` is the authority for creation, reuse, migration, and removal checks. On the certified host it reports a target such as `\??\UNC\wsl.localhost\Ubuntu-22.04\home\...`. `subst` output is diagnostic only.

## Trusted task context

The bundled `SessionStart` hook derives the distro and workspace from Codex's trusted `cwd` and creates a 256-bit, 24-hour `contextId`. The context is limited to Windows-native tasks opened through `\\wsl.localhost\...` or `\\wsl$\...` below the distro root.

The MCP server exposes only:

- `wsl_preview_status({ contextId? })`
- `prepare_preview_artifacts({ contextId, paths, probeResourceLinks? })`
- `release_preview_mapping({ contextId })`

The old model-supplied `distro` and `workspaceRoot` tools are internal compatibility methods, not public MCP tools. Files are canonicalized after symbolic-link resolution and must remain inside the hook-bound workspace.

## Hooks and limits

`hooks/hooks.json` is bundled and discovered with the plugin. Codex does **not** automatically trust plugin hooks: review the current hook hash through `/hooks`, and review it again after an update.

`SessionStart` asks the model to prepare file links before answering. `Stop` detects clickable raw WSL links inside the trusted workspace and requests at most one continuation. This is best-effort correction: hooks cannot rewrite an already rendered message, force MCP approval, or provide a Desktop filesystem-provider API.

The stable fallback is:

```markdown
[report.md](<V:/report.md>) · `/home/user/workspace/report.md`
```

Three MCP ResourceLink forms can be returned only when `probeResourceLinks: true`. They remain an explicit UI gate and are not used automatically until label, hover, copy, click, `resources/read`, and built-in preview behavior are confirmed. Resource reads are capped at 32 MiB and are reported as `contentTransport: "mcp-resource-read"`; this is not described as zero-copy.

Runtime state prefers Codex's writable `PLUGIN_DATA` directory. Standalone development falls back to `%LOCALAPPDATA%\OpenAI\Codex\plugins\wsl-native-preview`. Session contexts are removed at `SessionEnd`; drive aliases remain until explicitly released so existing chat links do not silently break.

See [INSTALL.md](docs/INSTALL.md), [CLEANUP.md](docs/CLEANUP.md), and [V2-GATE.md](docs/V2-GATE.md).
