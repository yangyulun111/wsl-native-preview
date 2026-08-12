# v0.2 verification status

## Automated evidence

- Target Desktop: `26.803.5235.0`
- Target Codex: `0.147.0-alpha.6.5`
- Agent mode: Windows native
- Login context: non-elevated current-user session
- Node support matrix: 22 and 24

On the certified host, direct `WNetAddConnection2W` workspace-subdirectory mapping returned Windows error `64` and left no drive. The working backend remains `subst.exe`, accurately reported as a target-build-gated DOS-device alias. Creation, reuse, migration, and release require an exact `QueryDosDeviceW` target.

Automated coverage includes:

- Unit tests for trusted UNC parsing, context expiry, path containment, symbolic-link escape, state locking, migration, candidate-drive collision, Unicode, URI encoding, and exact cleanup.
- MCP `2025-06-18` negotiation, public tool schema, resource protocol reads, JSON-RPC-only stdout, and empty stderr.
- Reproducible bundled server and Hook output.
- Linux Node 22/24 and Windows Node 22/24 CI.
- Release metadata, relative-path boundary, and sensitive-content checks.

## Previously certified fallback

Normal drive-path Markdown entered the built-in previewer before and after Desktop restart and after `wsl --shutdown` plus explicit recovery. Raw drive text and Markdown `file:///` did not. Windows-local preview behavior was unchanged.

## Manual gates for each Desktop build

- Git marketplace installation and upgrade.
- Hook hash trust and SessionStart heartbeat.
- Markdown, PNG, PDF, and PPTX built-in preview.
- Windows-local preview regression.
- ResourceLink label, hover, copy, click, protocol read, and preview behavior.
- Stop continuation UX.
- Desktop restart and WSL shutdown lifecycle.

CI success does not imply these UI and login-session gates passed.
