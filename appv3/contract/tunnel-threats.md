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

These are the protocol roles; each device's roster entry says which it
has (spec §3.1, `server` and `client`).

- **Host** (`server: true`): a computer that runs agents, which is the
  `agentd` server running as the desktop sidecar or from the CLI. It holds
  a presence socket, answers relay sessions, and, when its setting is on,
  listens for direct sessions on its private addresses (spec §5.5). A
  device without `server` runs no connector.
- **Controller** (`client: true`): the phone (it has no backend, so it is
  never a server), or a computer used to reach the others. It opens relay
  sessions to hosts.
- **Signer** (`signer: true`): signs rosters. The first device, whatever
  it is, and by default every later phone or desktop app. A computer that
  runs only the CLI joins as a member.
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
| A host's private addresses and direct port | the host; each controller stores them per device id and network | only inside an established session, to devices of the account |
| Departed set and last contact time | `cloud/identity.json`, next to `K` | never |

The account id identifies a person, so logs carry only a short hash of it.

## Storage

| Secret | iOS | Android (later) | macOS desktop and CLI | Linux desktop and CLI | Windows desktop |
|---|---|---|---|---|---|
| `auth`, `box` | Keychain, this device only, after first unlock; `box` also as its own item in the App Group's access group, for the notification extension | Keystore-wrapped | `cloud/identity.json`, mode 600 | the same file (Secret Service is a later step) | the same file, with no ACL of its own: it inherits the ACL of the user's profile folder (the user, SYSTEM and Administrators) |
| `sign` | Keychain, user presence required | Keystore, user authentication required | the same file; used only after a click in the app plus Touch ID or the login password where available | same, after a click | same, after a click |
| Tokens, nonces, invite secret | memory only | memory only | memory only | memory only | memory only |

Why the user-only file on macOS computers? The desktop app is ad hoc
signed, so a Keychain item is tied to the build's code hash, and macOS asks
for access again after every update (`desktop/src-tauri/AGENTS.md`). The
desktop access keys already moved to a user-only file for that reason.

**Computer signers: the trade-off.** A desktop app may be a signer (it is
by default when it joins, and always when it is the first device). Its
`sign` key is in that user-only file, not behind hardware user presence as
on a phone. So anyone who can read the user's files, or run code as the
user, can sign a roster that adds their own device. We accept this
because that attacker already controls this computer (its shell, files,
and agents) and could act as it anyway; the account's other devices were
always reachable from it as a client. What we do about it:

- the app signs only after the person at the screen clicks Approve, plus
  Touch ID or the login password through LocalAuthentication where the
  platform has it; the routes that sign answer only local callers, never a
  relay session or the LAN, and agent tools already deny reading
  `cloud/identity.json`;
- a local caller is not enough, because an agent's shell is one. The two
  server routes that sign a roster, `POST /api/cloud/approve/confirm` and
  `POST /api/cloud/devices/remove`, also need the **approval proof** that
  only the desktop app can make (described below). Creating the account
  (genesis on an empty account) needs no proof. The routes that sign
  nothing (`approve/begin`, `approve/reject`, `pending`, `devices`) need no
  proof either; a rejection is always safe;
- `agentd cloud approve`, and `agentd cloud login` when it would create the
  account, run only for a person: they refuse unless stdin and stdout are
  both terminals, and refuse whenever `AGENTD_AGENT` is set (below);
- every added device shows on every other device's device list, and any
  signer can remove it;
- a person who wants the stronger model keeps signing on the phone: when a
  computer joins later they approve it as a member, and a CLI-only
  computer is a member by default.

**The approval proof.** At each launch the desktop app makes a random
32-byte key, in memory only. When it starts its bundled server it passes
`--approval-key-stdin` and writes the key as one line (unpadded base64url)
into a pipe that is the server's stdin, then closes its end. The key is
never in an environment variable, a file, an argument or a log. The
server reads the line straight from the descriptor before any thread
starts, into memory zeroized on drop, then points stdin at `/dev/null`,
which closes the pipe; every other descriptor it opens is close-on-exec.
So nothing the server starts later (the agent's shell, terminals, MCP and
language servers, plugins) inherits the key or the pipe. On Windows the
pipe stays open in the server but is drained, and the app's end is
closed, so a child that inherits it reads end-of-file. A server started
any other way (`agentd server start`, a terminal) has no key, so its two
signing routes refuse every request; the person uses `agentd cloud approve`
in a terminal instead.

After the person confirms (Touch ID or the login password through
LocalAuthentication where the platform has it, otherwise the explicit
click), the app's `cloud_approval_proof` command returns

    X-Agentd-Approval: b64url(HMAC-SHA256(key,
        "agentd-approve-v1" || 0x00 || action || 0x00 || id || 0x00 ||
        signer "," server "," client))

where `action` is `approve` (id: the enrollment id, roles as granted) or
`remove` (id: the device id, roles all `0`), and each role is `1` or `0`.
The server compares it in constant time, after `local_only` and before it
touches the open approval. A missing key, a missing header or a wrong MAC
(another key, enrollment, device, set of roles or action) answers `403`
with a fixed message ("Approve in the OpenAgentd app on this computer, or
run agentd cloud approve in Terminal."; for removal, "Remove devices in
the OpenAgentd app on this computer."). The web UI in a plain browser,
where there is no app to make the proof, shows that message instead of
the buttons.

**The agent marker.** `AGENTD_AGENT=1` marks every process an agent can
drive. The server and `agentd run` set it on themselves before any thread
starts, so the agent's shell commands, git hooks, plugins and package
installs inherit it; the shell tool, MCP servers and language servers
(which start from an empty environment) set it explicitly. The terminal
tabs the person opens in the app remove it.

**What this does not stop.** These checks raise the bar for an agent that
was talked into approving a device (prompt injection, together with a
stolen account session that created the request). They do not stop
arbitrary code running as the user: such code can read `cloud/identity.json`
and sign a roster itself, unset `AGENTD_AGENT`, fake a terminal with
`script`, or drive the app's window. That residual risk is the trade-off
above, accepted because such code already controls this computer.

A stolen key of a member computer cannot approve devices. It can act as
that computer, which someone who can read the user's files can do anyway.

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
  only ids its verified roster still lists. That set is kept on disk with
  `K` (spec §3.3), filled from the relay's `revoked` list and from
  `GET /v1/devices`, and applied to direct sessions as well as relay
  ones. Response bodies from the cloud
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
- **A computer that approves can show an invitation too** (desktop app,
  Settings → Account → Add a device; `POST /api/cloud/invite/{start,poll,
  add,cancel}`, `crates/api/src/cloud/invite.rs`). What it adds: the QR
  code is on a computer screen, so screen sharing, a screen recording or a
  remote-desktop session can capture it for its 10 minutes, and a
  computer's screen is watched by more people than a phone's. What limits
  it: the same rules as the phone (the candidate is shown with its kind and
  fingerprint; it is added only on Add, which needs the desktop app's
  approval proof after Touch ID or the login password where the Mac has
  one, exactly as `approve/confirm`; two valid proofs add nobody and cancel
  the invitation). The routes answer only local callers, never a relayed
  device or the LAN. Starting an invitation and reading its candidates also
  need the app's proof (action `invite`, no Touch ID): they sign nothing,
  but the link is a bearer secret and an agent's shell is a local caller.
  The invitation lives in the server's memory only, and is cancelled when
  the sheet closes, after 10 minutes, when another one starts, and when the
  server stops or signs out; the link is answered once and never logged.
- With the 6-digit code (glance and tap, the default for a device that
  signs in), a new device joins only after the
  person compares the code on both screens (spec §4.2). The cloud commits
  to the keys it would swap
  before it sees the signer's nonce, so it wins by chance at most once in a
  million per attempt, and each attempt shows the person a failed code.
  The roles the device asked for are inside `pubs`, so they are covered by
  the commit and the code; the signer writes those roles or fewer, never
  more, and the cloud refuses a roster that adds a role `pubs` did not ask
  for.
- **Signing in alone grants nothing.** The device code flow only proves
  the person holds the account's email; the device joins only through a
  signer's roster after the code comparison. A phished or stolen email
  sign-in yields a pending enrollment that every signer is told about.
- **The approval push** (spec §4.5) has fixed text and an approval
  category, and no device name, id or secret, so the push service and the
  cloud learn nothing from it beyond "this account has a pending
  enrollment". A forged or replayed push only opens the approval sheet,
  which reads pending enrollments with a signed request and still needs the
  code. A flood of pending enrollments is limited per account by the cloud;
  the sheet shows each with its fingerprint and code, and the person
  rejects what they did not start.
- The signer checks the commit. A mismatch cancels the enrollment and tells
  the person that someone may be trying to join.
- A joining device trusts the roster head it fetches at step 3. The code
  covers the signer's keys from that roster, so a substituted head fails
  the comparison.
- **Genesis on a computer** puts the account's only signer key in a
  user-only file (see "Computer signers: the trade-off"). Any device may
  be first; `agentd cloud login` asks the person to confirm before it
  creates the account from a computer. Adding a phone later and approving
  from it keeps a signer behind biometrics.
- **Recovery code.** It is shown once. The person must type two groups back
  before genesis continues. The seed is zeroized after `recovery_sig`.
  The code may be selected, copied (**Copy code**) and screenshotted, and
  the step says to keep it in a password manager, a screenshot or on paper.
  Allowed because the code alone does not open the account: recovery
  (`POST /v1/enroll/recover`) also needs an enrollment session, which only
  a sign-in to the account's email gives. What remains: a copy is readable
  by other apps on that device until it is overwritten; the app writes an
  empty string over it once, two minutes later while it is visible (or on
  its next return), best effort (a browser may refuse a write without a
  tap; iOS has no expiring pasteboard in this build). A screenshot may sync
  to a photo library (iCloud Photos), so the advice names a password
  manager first.

### 3. Relay sessions

- The controller knows the host's `box` key from its verified roster
  (Noise IK). The host accepts a session only if the initiator's static key
  is the `box` key that its own verified roster lists for the offer's
  `from` device, and that device is active and has `client: true`.
  Otherwise it closes with 4002. The controller lists and dials only
  devices with `server: true`.
- **Roles limit a compromised box.** A server-only device (for example a
  CI machine joined with only **Use as server**) cannot open sessions to
  the other hosts: every host refuses it with 4002 and the cloud does not
  give it controller sessions. So stealing its keys gives that machine,
  not the account's other computers. A client-only device runs no
  connector, so nothing reaches it through the relay. The cloud's role
  checks are defense in depth; a hostile cloud cannot grant a role, since
  roles are only in the signed roster.
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
  sign-in code in progress, and a join's 6-digit code, only to this
  computer.
- A relay session is checked against the roster again after it is
  registered and before each stream; a controller removed in between is
  closed with 4001.

### 3a. Direct sessions on the home network

The home network is untrusted: other people's devices, a guest, a
compromised smart plug, or someone else's network that reuses the same
addresses.

- **Spoofing the host.** The controller encrypts message 1 to the host's
  `box` key from its verified roster, and the prologue names the host. A
  machine that took over a remembered address can't read message 1 or
  answer it, so the controller moves to the relay. Nothing is sent before
  the handshake except the greeting and message 1, which carries no
  readable identity (the controller's static key is encrypted). No
  credential ever goes to an address.
- **Spoofing a controller.** The host admits only a static key that its
  verified roster lists with `client: true`, that is not departed, and
  only within 7 days of its last contact with the cloud. A replayed
  message 1 gets a message 2 but no usable keys. The host acts on nothing
  until a transport message decrypts.
- **Removed devices.** A roster removal or a departed id closes live
  direct sessions (Go Away 4001) and refuses new ones. A device that left
  by itself is refused through the departed set, which the host saves on
  disk, so a restart without internet still refuses it. **What remains:**
  a device removed while the host is cut off from the cloud keeps access
  until the host hears from the cloud again, at most 7 days.
- **Tampering.** AES-GCM on every message. Any failure closes the
  connection. Lengths are checked before anything is read into memory.
- **Information disclosure.** On the home network, an observer sees that
  two devices talk, how much and when (as the relay does), and the
  OpenAgentd greeting. Nothing is compressed. On another network with the
  same subnet, an observer sees one greeting and one message 1, which
  identify neither the device nor the account. Addresses travel only
  inside sessions, so the cloud never learns them.
- **Denial of service.** The greeting is checked before any key work.
  Message 1 has a fixed length. There are at most 16 unfinished
  handshakes, 4 per peer address, with a 5 s deadline. The worst a local
  attacker achieves is pushing the phone onto the relay.
- **Exposure.** The listener is bound to private addresses only, and
  refuses peers that aren't on private addresses. It speaks only this
  protocol, never HTTP, so nothing of the server can be reached without a
  finished handshake. A computer with no private address has no listener.
- **Elevation.** Direct streams go through the connector exactly as relay
  streams do (§4): `RelayPeer` marker, headers stripped, account routes
  refused, never loopback.
- **Kept apart from LAN access.** The direct listener and the LAN listener
  ("Allow devices on your network to connect") are separate sockets on
  separate ports, with separate switches. The direct listener accepts no
  access key, and the LAN listener accepts no device key. An account
  computer is never reached through a saved address, and its addresses
  are never saved as a server.
- **The switch.** Settings → Server turns direct sessions on and off
  through a route that answers local callers only, never relayed, direct
  or LAN ones. Turning it on admits only the account's devices. Turning it
  off closes live direct sessions.

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
- The opened text never shows more than the person's Show Previews setting
  allows. iOS applies that setting to the text the extension sets (only
  while unlocked for "When Unlocked", never for "Never"); with "Never" the
  extension does not open the letter at all and the placeholder stays.
- Notification text comes only from the sealed JSON, never from the
  push payload's outer fields.

## What this model does not cover

- LAN access with an access key (saved servers). It is a separate
  feature, not part of the account: whoever answers at a saved address
  receives that key over plain HTTP, and the key works for whoever holds
  it, in the account or not. Account computers do not use it (§3a).
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
- [ ] An added device gets the roles its `pubs` asked for or fewer, never
      more. Hosts refuse sessions from devices without `client`, devices
      dial only `server` devices, and a device without `server` runs no
      connector.
- [ ] A computer signs a roster only after a click by the person at its
      screen (plus Touch ID where available), through routes that refuse
      relayed and LAN callers and need the desktop app's approval proof
      for exactly that change; the CLI signs only at a terminal and never
      under `AGENTD_AGENT`.
- [ ] The approval key never reaches an environment variable, a file, an
      argument, a log or a child process.
- [ ] No URL from a response is opened. The hosts are the compiled
      constants.
- [ ] Relayed requests cannot reach the account routes, cannot carry
      client credentials, and never count as loopback.
- [ ] Direct sessions admit the same devices as relay sessions (roster
      `client`, not departed) through one admission check, and apply the
      7-day contact rule. The listener refuses non-private peers and
      limits unfinished handshakes.
- [ ] No address or route information goes to the cloud. Addresses are
      answered only to a session's device.
- [ ] Nothing crosses between account sessions and LAN access: no access
      key on the direct listener, no device key on the LAN listener, no
      saved address used for an account computer.
- [ ] Errors shown to people use the copy in the plan. Errors sent to logs
      carry no keys or tokens.
