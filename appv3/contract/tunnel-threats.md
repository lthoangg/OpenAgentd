# Client threat model: OpenAgentd Cloud accounts

This is the client side of `tunnel.md`, covering what OpenAgentd devices
(the phone app, the desktop sidecar, the CLI server) must do to stay safe
when the cloud, the network or another app on the device is hostile. The
code it describes lives in `native/cloud` (the protocol crate), the
`cloud` module of the `agentd` server, and the mobile shell.

Every change that touches these boundaries gets the security axis of the
`oad/review` review checked against the checklist at the end. The
connector and the phone bridge also get a dedicated security pass before
they merge.

## Roles

- **Host:** a computer that runs agents, which is the `agentd` server
  running as the desktop sidecar or from the CLI. It holds a presence
  socket and answers relay sessions.
- **Controller:** the phone. It has no backend, opens relay sessions to
  hosts, and is also the only signer in version 1.
- **Cloud:** the account API and the relay. It is untrusted. It can deny
  service and see metadata (who talks to whom, when, and how much), but it
  must not be able to add a device, read traffic, forge a notification, or
  run anything on a host.

## Assets

| Asset | Where it lives | Leaves the device |
|---|---|---|
| `auth` private key (Ed25519, signs cloud requests) | OS store or user-only file (see Storage) | never |
| `box` private key (X25519, Noise static key, 6-digit code, letters) | same | never |
| `sign` private key (Ed25519, signs rosters) | same; on iOS behind Face ID / Touch ID / passcode | never |
| Recovery seed | shown once at genesis, then zeroized | only as the code the person writes down |
| Enrollment session (`e1.`), relay token (`t1.`), nonces (`n1.`) | memory only | sent to the cloud only |
| Invitation secret | memory only, in the QR code | never to the cloud |
| Verified roster `K`, account id, account state | app data; not secret, but integrity matters | the account id goes to the cloud |
| APNs token | memory, then the cloud | to the cloud |
| Everything a host can do (shell, files, agents) | the host | reachable through relay sessions |

The account id identifies a person, so logs carry only a short hash of it.

## Storage

| Secret | iOS | Android (later) | macOS desktop and CLI | Linux desktop and CLI | Windows desktop |
|---|---|---|---|---|---|
| `auth`, `box` | Keychain, this device only, after first unlock; `box` also as its own item in the App Group's access group, for the notification extension | Keystore-wrapped | `cloud/identity.json`, mode 600 | the same file (Secret Service is a later step) | user-only file |
| `sign` | Keychain, user presence required | Keystore, user authentication required | the same file (hosts are members) | same | same |
| Tokens, nonces, invite secret | memory only | memory only | memory only | memory only | memory only |

Why the user-only file on macOS computers? The desktop app is ad hoc
signed, so a Keychain item is tied to the build's code hash, and macOS asks
for access again after every update (`desktop/src-tauri/AGENTS.md`). The
desktop access keys already moved to a user-only file for that reason.
Hosts are members, so a stolen host key cannot approve devices. It can act
as that host, which someone who can read the user's files can do anyway.

Secrets never go to settings JSON, SQLite, `server.yaml`, logs, crash
reports or telemetry. Secret types zeroize on drop and print `[redacted]`
when formatted. The HTTP trace layer drops `Authorization` and every
`X-Agentd-*` header.

## Boundaries and threats (STRIDE)

### 1. Device ↔ cloud API

- **Spoofing the cloud.** The hosts are compile-time constants
  (`https://api.openagentd.dev`, `https://account.openagentd.dev`). Only
  debug builds read an override from the environment. Release builds have
  no override, so nobody can be talked into a malicious server. TLS uses
  the platform roots via rustls.
- **Phishing through the device code.** The app never opens a URL taken
  from a response. It opens `https://account.openagentd.dev/device?code=` +
  the user code, after checking the code against the RFC 8628 alphabet
  (`^[BCDFGHJKLMNPQRSTVWXZ]{4}-?[BCDFGHJKLMNPQRSTVWXZ]{4}$`). It shows the
  device fingerprint next to the code, so the person can check that the
  page names the same device.
- **Tampering with rosters.** Every roster is verified (spec §3.2) before
  it is used or stored, and `K` is replaced only by a roster valid after
  it. Parsing is strict: base64url without padding and with canonical
  trailing bits, exact JSON keys, exact lengths.
- **Signatures.** Ed25519 is verified strictly (no small-order keys, no
  malleable signatures). An X25519 exchange that yields all zeros is
  rejected. MACs and commits are compared in constant time.
- **Repudiation.** Account changes (sign-in, join, approve, remove, sign
  out) are logged locally with device ids, never with keys or tokens.
- **Denial of service.** The cloud can refuse service. Clients back off
  with jitter, retry at most once after a `401`, respect `Retry-After` and
  `paused_until`, and retry "account unavailable" every few minutes at
  most.
- **Account state.** The account errors map to client states in a single
  function (`native/cloud/src/account_state.rs`). Closing and unavailable
  keep every key and the roster. Only `account_deleted` and a signed
  answer that this device was removed (`device_revoked` 403, or a verified
  roster without it) erase the account's keys; a `device_revoked` is never
  retried as a stale nonce, since only a `401` is. The relay's word alone
  (its `revoked` list naming this device, a 4001 close, a refused relay
  token) is unsigned: the device closes its sessions, stops relaying, and
  asks with one signed `GET /v1/roster` (`Member::confirm_removal`); any
  other answer keeps the keys for a later retry. A host keeps at most 16
  id-shaped entries of a `revoked` list, and its set of departed devices
  only ids its verified roster still lists. Response bodies from the cloud
  are read up to 1 MiB, and ids and nonces from the cloud are checked
  before they go into a URL path or `lines(...)`. Local data is never
  touched, and no state stops local use (spec §1,
  "What keeps working"): a host keeps serving local and LAN clients, a
  phone keeps its saved servers; only relay sessions and letters stop.

### 2. Joining an account

- **Invitations (spec §4.3) are a bearer secret.** Anyone who sees the QR
  code or link before it is used or expires can claim it with a valid
  `proof`. A signer must: show the QR code only while the person is adding
  a device; offer the link only behind a step that says it works like a
  password; show each candidate's fingerprint and kind (which the new
  device shows too) and add it only after the person confirms, never the
  first valid candidate on its own; and when more than one `proof` checks
  out, add none, cancel the invitation (`DELETE /v1/invite/{slot_id}`),
  tell the person, and offer a new one. The secret stays in memory and is
  never sent to the cloud or logged. The new device trusts its first
  roster only after `confirm` checks out under the secret.
  In code (`native/cloud/src/flows.rs`): `check_candidates` drops every
  candidate whose proof fails (and one whose `auth_pub` does not derive its
  id), and cancels on two valid proofs; `add_invited` needs the enrollment
  id the person picked and runs that check again just before the roster
  write, so a second claim while the card is open still adds nobody. The
  phone keeps the open invitation in its shell (`cloud_invite_*`), drops
  it when the sheet closes or the app leaves the foreground, and hands the
  web view the link only to draw the QR code. A computer takes the link
  from a password field (`POST /api/cloud/join`, local callers only) or a
  hidden prompt (`agentd cloud join`), never from argv or a log.
- With the 6-digit code (the fallback), a new device joins only after the
  person compares the code on both screens (spec §4.2). The cloud commits
  to the keys it would swap
  before it sees the signer's nonce, so it wins by chance at most once in a
  million per attempt, and each attempt shows the person a failed code.
- The signer checks the commit. A mismatch cancels the enrollment and tells
  the person that someone may be trying to join.
- A joining device trusts the roster head it fetches at step 3. The code
  covers the signer's keys from that roster, so a substituted head fails
  the comparison.
- **Genesis on a computer** (`--first-device`) puts the account's only
  signer key in a file. The CLI warns about this. The default is genesis on
  the phone, behind biometrics.
- **Recovery code.** It is shown once. The person must type two groups back
  before genesis continues. The seed is zeroized after `recovery_sig`.

### 3. Relay sessions

- The controller knows the host's `box` key from its verified roster
  (Noise IK). The host accepts a session only if the initiator's static key
  is the `box` key that its own verified roster lists for the offer's
  `from` device, and that device is active. Otherwise it closes with 4002.
- The prologue binds the account, the session and both device ids.
- A device removed from the roster loses every session at once (4001), and
  new streams check the roster again.
- **Information disclosure.** Nothing is compressed through the tunnel
  (sizes would leak content). Letters are padded to fixed sizes.

### 4. Connector → host server (the most sensitive boundary)

A relayed request carries full control of the host: shell, files and
agents. Without an access key, the server trusts every loopback caller.
The connector therefore must never look like a loopback caller.

- Each yamux stream is served by the server's own router, in-process. The
  connection has no socket address. The connector attaches a `RelayPeer`
  marker with the device id, which no header can produce.
- `RelayPeer` authenticates as `RelayDevice`, with the rights of a client
  holding the access key. Loopback trust is never consulted.
- The connector removes these headers before routing:
  - `Authorization`, the access-key query parameter and `Cookie`, so
    credentials come only from the session;
  - `Forwarded`, `X-Forwarded-*` and `Via`, so no client can steer the
    proxied-peer logic;
  - `Accept-Encoding`, so no compression;
  - `Origin`, since the phone bridge authenticated the page itself.
- A `Host` other than `localhost` gets `400` and the stream closes.
- Account routes (`/api/cloud/login`, `/api/cloud/logout`) refuse
  `RelayDevice` and LAN callers. A relayed device cannot sign the host into
  another account or out of this one. `GET /api/cloud/status` shows a
  sign-in code in progress only to this computer.
- A relay session is checked against the roster again after it is
  registered and before each stream; a controller removed in between is
  closed with 4001.

### 5. Phone bridge → web UI

The mobile shell serves `http://127.0.0.1:<port>` so the web UI can use
SSE and WebSockets through the relay. Other apps on the phone could
connect to that port.

- The bridge listens on `127.0.0.1` only and requires a random 256-bit key
  per launch, compared in constant time. The web UI gets it as that
  origin's access key from `secure_get_access_key`, which answers bridge
  origins from memory: the key is never written anywhere.
- A request with an `Origin` other than the app's own webview is refused
  before anything is forwarded, whatever key it carries. The bridge answers
  CORS preflights itself, for the app's origin only.
- The bridge strips the key (header and query), `Origin` and `Cookie`, and
  sets `Host: localhost` before tunnelling. The computer's connector strips
  again, so neither side depends on the other.
- Signing out, removing the computer, or an account problem closes the
  relay session; the bridge then answers `502`. iOS suspends it with the
  app.

### 6. Notifications

- Hosts send only what a local notification shows (status, workspace name,
  session title, clamped), sealed to each signer of the verified roster.
  The `collapse` key the cloud sees is a hash of the sender and session
  id, so it groups one session's notifications without naming the session.
- The cloud stores only sealed letters. A push carries the sealed letter
  and nothing else, so the notification extension tries each device of the
  verified roster and each kind: AES-GCM fails for every wrong guess, and
  the static-static term means only a device of the account can make a
  letter that opens. The public keys it needs (`cloud-push.json` in the App
  Group container) are not secret; the phone's `box` key is a Keychain
  item. A letter that does not open shows the placeholder text.
- Notification text comes only from the sealed JSON, never from the
  push payload's outer fields.

## What this model does not cover

- The LAN path. When a computer of the account also has a saved LAN
  address, the phone tries it first and uses the access key saved for it,
  as it does when that saved server is chosen by hand. Whoever answers at a
  remembered LAN address receives that key over plain HTTP; this is the
  existing LAN pairing's risk, not the relay's.

- A compromised host or phone. Its keys act as that device until a signer
  removes it.
- A cloud that hides a roster update from an isolated device. Version 1
  has no history route (spec §9).
- Traffic analysis beyond what padding and no-compression remove.

## Dependencies

Crypto comes from the RustCrypto and dalek projects, so nothing is written
by hand except the protocol glue. Every dependency is pinned by the lock
files of `native/cloud`, `appv3` and `mobile/src-tauri`, and checked with
`cargo audit`. The current list and the reasons for each are in
`native/cloud/Cargo.toml`.

## Review checklist

- [ ] No secret, token, real email, account id or infrastructure id in the
      diff, the tests or the commit message (`scripts/check_no_secrets.py`).
- [ ] Commit messages and comments describe product behavior, not how the
      cloud is operated.
- [ ] New secrets go through the platform store abstraction and are
      redacted when formatted.
- [ ] Every roster use goes through `roster::verify` (or, for a device's
      first roster after an invitation, `confirm` then
      `roster::verify_first`). Nothing is trusted outside the verified
      roster.
- [ ] No invitation candidate is added without a person's tap, and two
      valid proofs add nobody.
- [ ] No URL from a response is opened. The hosts are the compiled
      constants.
- [ ] Relayed requests cannot reach the account routes, cannot carry
      client credentials, and never count as loopback.
- [ ] Errors shown to people use the copy in the plan. Errors sent to logs
      carry no keys or tokens.
