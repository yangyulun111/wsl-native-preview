# Safe cleanup

Prefer `release_preview_mapping({ contextId })` from the task that owns the workspace mapping. The tool removes an alias only when plugin state marks it as owned and `QueryDosDeviceW` still reports the exact recorded target.

If the task context has expired, inspect the drive before any manual cleanup:

```powershell
subst
```

Do not remove a drive that points somewhere other than the expected `\\wsl.localhost\<distro>\...` workspace. A changed or unrelated mapping belongs outside the plugin's cleanup authority.

After releasing the verified alias, uninstall the plugin through Codex Desktop and remove the marketplace only if it is no longer needed:

```bash
codex plugin marketplace remove yangyulun111-wsl-native-preview
```

`/persistent:no` and SessionEnd are not automatic alias cleanup guarantees. A WSL or Desktop restart may invalidate an alias; a later explicit prepare operation can recreate it after verifying the target and candidate drive.
