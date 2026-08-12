# Contributing

Contributions are welcome for narrowly scoped fixes, tests, documentation, and compatibility gates.

## Development

Use Node.js 22 or 24. From the plugin directory:

```bash
npm ci
npm test
npm run build
npm run smoke:mcp
npm run validate:release
```

Commit changes to `src/` together with the reproducible `dist/` output. Do not commit runtime state, local drive mappings, credentials, workspace documents, or `node_modules`.

## Pull requests

- Explain the affected Windows, WSL, Codex Desktop, and Node versions.
- Keep the public MCP surface workspace-bound.
- Add tests for security-boundary changes.
- Treat Desktop preview routing, Hook trust, login-session visibility, and WSL lifecycle checks as manual gates rather than CI claims.
- Update all three version locations and `CHANGELOG.md` for a release.
