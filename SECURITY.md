# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting or a private security advisory for issues that could expose files outside the bound workspace, delete an unrelated drive alias, execute unintended commands, or leak task context.

Do not include real credentials, user identifiers, workspace documents, or runtime state in a public issue.

## Security boundary

The plugin accepts only Hook-created task contexts, canonicalizes requested files, checks containment after symbolic-link resolution, and removes a drive alias only when its current target exactly matches plugin-owned state. A context identifier is a short-lived bearer capability, not caller authentication.

The plugin does not provide arbitrary command, write, edit, or delete tools. Creating and releasing a DOS-device alias still changes user-session state and should be treated as a visible side effect.
