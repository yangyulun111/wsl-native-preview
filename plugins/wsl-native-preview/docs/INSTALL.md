# Installation and Hook trust

## Requirements

- Windows-native Codex Desktop task.
- Workspace opened through `\\wsl.localhost\<distro>\...` or `\\wsl$\<distro>\...`.
- Normal, non-elevated Windows login session.
- Windows Node.js 22 or newer on `PATH`; Node 22 and 24 are the supported matrix.
- One unused candidate drive among `W:`, `V:`, `U:`, `T:`, and `S:`.

The Git marketplace contains bundled `dist/server.mjs` and `dist/hook.mjs`, so installation does not execute npm lifecycle scripts.

## Rolling installation

```bash
codex plugin marketplace add yangyulun111/wsl-native-preview --ref main
```

Install **WSL Native Preview** from the Desktop Plugins Directory. If the available CLI runs inside WSL, use the Desktop UI because the Linux and Windows Desktop Codex profiles are separate by default.

## Pinned installation

```bash
codex plugin marketplace add yangyulun111/wsl-native-preview --ref v0.2.0
```

## Trust and first task

1. Open `/hooks`.
2. Review and trust the plugin's SessionStart, Stop, and SessionEnd commands.
3. Start a new task in the WSL UNC workspace.
4. Confirm `wsl_preview_status` reports a recent SessionStart heartbeat.
5. Prepare one Markdown file and confirm the returned drive-path link enters the built-in previewer.

Changed Hook definitions receive a new hash and require another review. ResourceLink remains probe-only until the target Desktop build passes its UI gate.
