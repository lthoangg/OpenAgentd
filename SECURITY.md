# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately via
GitHub's private vulnerability reporting:

- **GitHub:** [Security Advisories](https://github.com/lthoangg/openagentd/security/advisories/new)

Do **not** open a public issue for security vulnerabilities.

We aim to acknowledge reports within 48 hours and address them on a best-effort basis.

Only the latest version on the `main` branch receives security fixes.

## Hardening in place

| Area | Protection |
|------|-----------|
| **API authentication** | `OPENAGENTD_DESKTOP_TOKEN` / `OPENAGENTD_ACCESS_KEY` gates all API endpoints. Token comparison uses `hmac.compare_digest` (constant-time). The `?_token=` query-param is scrubbed from scope before logging. |
| **Workspace path containment** | `validate_workspace()` rejects paths inside OS system directories (`/etc`, `/proc`, `/sys`, `/dev`, `/bin`, `/sbin`, `/boot`, `/run`, `/usr/bin`, `/usr/sbin`, macOS `/private/etc`). Used by file listing, snippet, and command endpoints. |
| **Path traversal** | File-serving endpoints resolve and bounds-check all paths against the session workspace root before any I/O. `@mention` context injection uses the same guard (`_safe_join*`). |
| **Subprocess safety** | Internal subprocess calls use argument-list form (`subprocess.run([...])`) — no `shell=True` with string interpolation outside the sandboxed user shell tool. |
| **DuckDB query safety** | All observability queries use `?` parameterised placeholders. `trace_id` inputs are validated as hex strings (422) before reaching the database. |
| **Secrets hygiene** | Provider API keys are `SecretStr`; diagnostics reports boolean presence only. MCP OAuth secrets are stored in a `chmod 600` `.env` and masked as `"********"` in API responses. Keys are never logged or sent to the model. |
| **Security headers** | Every response carries `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, strict CSP, `frame-ancestors 'none'`, and a `Permissions-Policy` header via `SecurityHeadersMiddleware`. |
| **Request size cap** | `RequestSizeLimitMiddleware` rejects bodies over 4 MB (via `Content-Length`) before the body is read. |

For the full threat model and trust boundary analysis see [`documents/docs/architecture.md` — Security & trust model](documents/docs/architecture.md).
