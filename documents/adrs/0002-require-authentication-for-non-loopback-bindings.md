# ADR-0002: Require authentication for non-loopback bindings

## Status
Accepted

## Date
2026-07-11

## Context
OpenAgentd exposes APIs that can read and write files, execute shell commands,
open terminals, and invoke agent or MCP tools with the user's operating-system
permissions. Loopback-only development and single-user server launches may run
without an access key for compatibility, but binding the same API to a LAN or
public interface without authentication turns local capabilities into remotely
reachable capabilities.

The project already supports bearer authentication through a generated desktop
token or a configured server access key. Documentation recommends
`openagentd start --lan --key`, but alternate host flags and direct server entry
points could otherwise bind a non-loopback address without a key.

## Decision
OpenAgentd-managed server entry points refuse to bind a non-loopback host unless
either `OPENAGENTD_DESKTOP_TOKEN`, `OPENAGENTD_ACCESS_KEY`, or the persisted
`server.access_key` setting is non-empty. Loopback hostnames and IP addresses
remain usable without authentication. The ASGI application also rejects HTTP
and WebSocket requests accepted by an unauthenticated non-loopback listener,
covering direct external Uvicorn invocation; request middleware enforces the
configured bearer credential with that same credential source.

## Alternatives Considered

### Automatically generate a key for every non-loopback launch
- Pros: avoids refusing startup and produces an authenticated server.
- Cons: clients would not necessarily receive or persist the generated key;
  background and direct launches lack a safe universal delivery channel.
- Rejected because: silently generating an inaccessible credential creates a
  confusing server and may encourage insecure key output.

### Keep authentication opt-in and rely on documentation
- Pros: no compatibility change for custom launch commands.
- Cons: a missed `--key` exposes shell and filesystem capabilities to the
  network.
- Rejected because: a documentation mistake must not become remote code
  execution under the user's account.

### Require authentication on loopback too
- Pros: protects against all untrusted local processes.
- Cons: breaks established CLI/development workflows and is unnecessary for
  this targeted LAN hardening decision; desktop launches already generate a
  token.
- Rejected because: the immediate invariant is network exposure, while local
  authentication remains an explicit compatibility trade-off.

## Consequences
- `openagentd start --lan` without an access key fails with guidance to use
  `--key` or configure an access key.
- Direct Uvicorn/module paths may open a non-loopback socket, but cannot serve
  unauthenticated HTTP or WebSocket API requests on it.
- Existing loopback CLI and development workflows remain unchanged.
- New server entry points must reuse the same binding-policy check before
  opening sockets.
