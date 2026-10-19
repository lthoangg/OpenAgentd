# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately via
GitHub's private vulnerability reporting:

- **GitHub:** [Security Advisories](https://github.com/lthoangg/openagentd/security/advisories/new)

Do **not** open a public issue for security vulnerabilities.

Please include:

- the OpenAgentd version (`agentd --version`, or **Settings** in the app)
  and how you run it (desktop app, CLI server, iOS app, or from source)
- the affected endpoint, tool, or file, and the conditions required, such as
  an access key being set or the server listening beyond loopback
- steps or a proof of concept, and the impact you observed

We aim to acknowledge reports within 48 hours and address them on a best-effort basis.

## Supported versions

Security fixes ship in new releases. Only the
[latest release](https://github.com/lthoangg/OpenAgentd/releases/latest) is
supported, so please check that the issue still reproduces there.

## Hardening in place

These describe the Rust backend (`appv3/`) that ships in the desktop app and
the CLI.

| Area | Protection |
|------|-----------|
| **API authentication** | When an access key is set (the desktop app's per-launch token, `OPENAGENTD_ACCESS_KEY`, or `server.yaml`), every `/api/*` route except the health probes requires it as a Bearer token or `_token` query parameter, compared in constant time. The `_token` parameter is stripped from the request before handlers run. |
| **Network exposure** | The server refuses to listen beyond loopback without an access key. Without a key, it also rejects requests with a non-local `Host` header (DNS rebinding) and requests from origins outside the CORS allow-list. |
| **Workspace containment** | Workspaces cannot be inside system directories (`/etc`, `/proc`, `/sys`, `/dev`, `/run`, `/boot`, `/bin`, `/sbin`, `/usr/bin`, `/usr/sbin`, `/private/etc`). Paths are resolved through symlinks before the check. |
| **Path traversal** | File, upload, and `@mention` endpoints reject paths that resolve outside the session's workspace root. |
| **Agent file guard** | Agent file tools and shell commands refuse `.env` files and OpenAgentd's own data, state, and cache directories; its logs and telemetry stay readable for self-diagnosis. The shell check is lexical, not an OS sandbox. |
| **Subprocesses** | OpenAgentd's own subprocess calls (git, plugins, self-update) pass argument lists, not shell strings. Server credentials are removed from the environment of the agent shell, MCP servers, and plugins. |
| **Data access** | SQLite queries use bound parameters. Observability reads local span files, and trace IDs that aren't hex are rejected with 422. |
| **Secrets** | Diagnostics report only whether each provider key is set, never its value. MCP OAuth client secrets are stored in a `0600` `.env` file, and HTTP MCP headers and OAuth credentials are masked as `********` in API responses. |
| **Security headers** | Responses carry `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`, and a CSP with `frame-ancestors 'none'`. |
| **Request size cap** | Request bodies over 56 MiB are rejected with 413; a declared `Content-Length` is checked before the body is read. |

The server has no built-in TLS; put an HTTPS reverse proxy in front of it
before exposing it outside a trusted network. The enforcement points in
`appv3/crates/` and their tests are the authoritative record of these
invariants.
