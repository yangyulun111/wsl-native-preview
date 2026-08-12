---
name: wsl-native-preview
description: Preview generated files from the current Windows-native WSL UNC workspace in Codex Desktop. Use when a task produces or references a /home/... file, report, Markdown, image, PDF, presentation, or other artifact that should open in the built-in previewer.
---

# WSL Native Preview

Use the short-lived `contextId` injected by this plugin's trusted `SessionStart` hook. Do not ask the user or model to choose a distro or workspace root, and do not infer a replacement context.

## Workflow

1. If a `contextId` is present in developer context, optionally call `wsl_preview_status({ contextId })` for diagnostics.
2. Before the final answer contains clickable links to files inside the trusted WSL workspace, call `prepare_preview_artifacts` once with:
   - the injected `contextId`;
   - every exact absolute Linux file path that will be linked.
3. Render every returned `previewMarkdown` verbatim. It contains the gate-certified drive link and the visibly adjacent original Linux path.
4. Use `probeResourceLinks: true` only when the user explicitly requests the ResourceLink UI gate. Do not use probe links as the normal delivery form.

If no trusted context is available, explain that automatic conversion requires a new or resumed task opened through `\\wsl.localhost\<distro>\...` or `\\wsl$\<distro>\...` with the Windows-native agent. WSL-agent `/home/...` cwd and ordinary Windows workspaces are intentionally skipped.

## Safety rules

- Never expose or call the internal model-supplied distro/workspace compatibility methods.
- Never create a mapping during MCP initialization or `wsl_preview_status`.
- Never copy the source file as a drive-link fallback.
- Never modify Windows file associations, registry settings, Codex settings, or workspace roots.
- Do not transform Windows-native paths or links outside the trusted workspace.
- Do not call `release_preview_mapping` unless the user explicitly asks to clean up the current task's mapping.
- If MCP is unavailable or approval is denied, report the limitation once. Do not loop or claim that automatic correction succeeded.

## ResourceLink gate

The optional probe returns Windows file URI, Linux file URI, and `wsl-preview:` candidates. Record label, hover text, copied path, click destination, whether `resources/read` ran, and whether Codex used its built-in previewer. MCP does not guarantee these UI behaviors.
