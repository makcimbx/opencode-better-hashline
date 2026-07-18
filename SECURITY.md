# Security Policy

## Supported Versions

Before 1.0, only the latest released minor version receives security fixes.

| Version | Supported |
| --- | --- |
| Latest 0.x | Yes |
| Older 0.x | No |

## Reporting

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/makcimbx/opencode-better-hashline/security/advisories/new).
Do not open a public issue for path traversal, permission bypass, unintended file modification,
hash validation bypass, or credential exposure.

Include the plugin and OpenCode versions, operating system, minimal sanitized reproduction, impact,
and any suggested mitigation. You should receive an acknowledgement within seven days.

## Scope

The plugin is intended to prevent accidental stale or ambiguous text edits. It is not a sandbox for
malicious OpenCode plugins or local processes. OpenCode plugins run as trusted code with the user's
filesystem privileges.
