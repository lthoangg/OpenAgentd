# OpenAgentd tunnel protocol

This is the source of truth for the protocol between OpenAgentd devices and
OpenAgentd Cloud. The test vectors are in `tunnel_vectors.json`, beside this
file. Every implementation must reproduce them byte for byte; the Rust crate
`native/cloud` checks them in `native/cloud/tests/vectors.rs`. The client
threat model is `tunnel-threats.md`.

This file defines what devices compute and what the opaque fields of the
cloud API contain: keys, the roster, the 6-digit code, invitations, relay
sessions, and mailbox letters. The HTTP routes, limits, and error codes are
in the cloud's device API reference ("the API" below) and are not
repeated here.

**What the protocol guarantees.** The cloud (or anyone who controls it) can
deny service: refuse requests, drop relay traffic, or hold back a new
roster, which delays a removal on the devices that have not seen it yet.
It sees metadata: the account's sign-in email, its devices and their
kinds and roles, when they connect, and how much they send. It cannot add
a device, change a device's roles, read relay traffic or letters, run
anything on a host, or learn a 6-digit code or an invitation secret,
because:

1. every roster is signed by a signer device or the recovery key, and every
   device verifies it;
2. a new device joins only through a signer: by claiming an invitation
   whose secret never reaches the cloud, or after the user compares a
   6-digit code that both devices derive from a key agreement the cloud is
   not part of; the roles it asked for are inside what the code or the
   invitation proof covers;
3. relay sessions and letters are encrypted end to end to keys from the
   verified roster, and each side checks the other's role in it.

## 1. Conventions

- **base64url** is RFC 4648 section 5 without padding. "b64(x)" below means
  that encoding of the bytes x.
- **Lines.** Many signatures and derivations are over `lines(a, b, ...)`:
  the UTF-8 bytes of the arguments joined with `\n` (0x0A), no trailing
  newline. Arguments are ASCII: labels, ids, decimal integers, and b64
  values. No argument may contain `\n`.
- **SHA-256**, **HMAC-SHA256**, **HKDF-SHA256** (RFC 5869), **Ed25519**
  (RFC 8032, pure), **X25519** (RFC 7748), **AES-256-GCM** (12-byte nonce,
  16-byte tag). All of them exist in WebCrypto, so a browser can implement
  the protocol with no library.
- **JSON** is UTF-8. Where JSON is signed or hashed, the exact bytes the
  writer produced are signed or hashed; nobody re-serializes them.
- **Account state.** Three errors are about the account, not the request
  (the API, "Errors"). `account_closing` (with `deletes_at`): the
  account waits to be deleted and is locked. Keep every key, the roster,
  and the account's state; tell the person when it will be deleted and that
  signing in on the account pages and Keep account undoes it; retry later.
  Relay sockets close with 4011 meanwhile. `account_unavailable`: the
  cloud cannot serve the account for now. Keep everything the same way,
  tell the person the account is unavailable and to contact OpenAgentd,
  and retry now and then (every few minutes at most).
  Relay sockets close with 4012 meanwhile. `account_deleted`: the account
  is gone for good. Forget its keys, roster, and letters; joining again
  starts from a new device code.
- **Device state.** `device_revoked` (403): this device was removed or
  left. The cloud sends it only for a request signed with the device's own
  registered key. Forget the account's keys, roster, and letters, as for
  `account_deleted`; joining again starts from a new device code with new
  keys.
- **What keeps working.** None of these states stops OpenAgentd on the
  device itself: it keeps running and serving its own user, as it did
  before it joined. Only what goes through the cloud stops: reaching other
  devices through the relay, and letters. After `account_closing` or
  `account_unavailable` that comes back by itself once the account does;
  after `account_deleted` or `device_revoked` the device is on its own
  until it joins an account again.

## 2. Keys

Every device makes three key pairs when it is set up, and keeps the private
halves in the platform key store (Keychain, Android Keystore, the OS
credential store, or a file readable only by the user where the OS store
cannot hold the key without prompting, as on a server).

| Key | Type | Used for | Leaves the device |
|---|---|---|---|
| `auth` | Ed25519 | Signing cloud requests (the API, "Signed request") | Public half only |
| `box` | X25519 | Relay sessions (Noise static key), the 6-digit code, letters | Public half only |
| `sign` | Ed25519 | Signing rosters, when the device is a signer | Public half only |

- **User presence.** On a phone, using `sign` must require the user: Face
  ID, Touch ID, a fingerprint, or the device passcode (an access control on
  the key store item). On a computer with a screen (the desktop app),
  `sign` is used only after the person at that screen approves, by a click
  in the app plus the platform's user check (Touch ID or the login
  password) where the platform offers one; the key itself may sit in the
  user-only file (`tunnel-threats.md`, "Storage"). The app proves that
  approval to its own server with a per-launch key, so a local process
  such as an agent's shell cannot sign (`tunnel-threats.md`, "The approval
  proof"); this is local to the computer and does not change anything
  the cloud or other devices see. A server without a
  screen has a `sign` key too, so a signer can promote it later, but it
  should stay a member.
- **Device id** and **fingerprint** are derived from `auth`
  (the API, "Conventions" and "Device code").
- **Recovery key.** An Ed25519 key the first device makes at genesis. Its
  private half is shown once as the **recovery code** and then erased from
  the device: the 32-byte seed in RFC 4648 base32 (uppercase, no padding,
  52 characters), in 13 groups of 4 separated by `-`. It signs only a
  recovery roster (section 4.4). Input ignores case, spaces, and dashes.

### 2.1 `pubs`

A device's public keys besides `auth`, and the roles it asks for, sent as
`pubs` when it asks to join (pending enrollment or invitation claim). It is
the UTF-8 JSON

```json
{"v":2,"box":"<b64, 32 bytes>","sign":"<b64, 32 bytes>","server":true,"client":true}
```

and the API field carries b64 of those bytes. The new device writes the
members in this order. Every member is required; `server` and `client` are
booleans (section 3.1) and at least one is `true`. `v` other than 2 and
unknown members are errors. A reader does not depend on member order; the
code (section 4.2) and the invitation proof (section 4.3) cover the exact
bytes, so the cloud cannot change the requested roles without breaking
them.

## 3. Roster

The roster is the account's signed list of devices. The cloud stores the
latest one; every device verifies every roster it receives, and so does the
cloud on every write.

### 3.1 Format

The API's `roster` / `blob` field is b64 of an **envelope**, UTF-8 JSON:

```json
{"v":1,"body":"<b64 of the body bytes>","by":"<device_id or \"recovery\">","sig":"<b64, 64 bytes>"}
```

The **body** is UTF-8 JSON:

```json
{
  "v": 2,
  "account_id": "<account id>",
  "version": 5,
  "prev": "<b64(SHA-256(previous envelope bytes))>",
  "recovery_pub": "<b64, 32 bytes>",
  "devices": [
    {"id": "<device id>", "auth": "<b64>", "box": "<b64>", "sign": "<b64>", "signer": true, "server": true, "client": true}
  ]
}
```

- The envelope's `v` stays 1; the body's `v` is 2. Only body version 2 is
  accepted.
- Every device entry has exactly the members shown, all required; writers
  put them in this order, readers do not depend on it. `signer`, `server`,
  and `client` are booleans.
- **Roles.** `server: true`: the device runs a host (section 5) and other
  devices may open sessions to it. `client: true`: the device may open
  sessions to hosts. A device has at least one role. `signer` is separate:
  it says who may sign the next roster.
- `prev` is `null` in the genesis roster only.
- `devices` holds 1 to 10 entries with distinct ids; each `id` is derived
  from its `auth`. Order carries no meaning.
- No names, kinds, or other labels: the cloud reads the roster.
- The envelope is at most 64 KiB.

`sig` is an Ed25519 signature over

```
lines("agentd-roster-v1", account_id, version, b64(SHA-256(body bytes)))
```

by the `sign` key of the device `by`, or by the recovery key when `by` is
`"recovery"`.

### 3.2 Verifying a roster

A roster `R` is **valid after** a known roster `K` (the last one this
verifier accepted) when all of these hold:

1. Both envelope and body parse, the envelope's `v` is 1, the body's `v`
   is 2, every device entry has exactly its seven members, and every field
   has its type.
2. `R.account_id` is the account, and `R.version > K.version`.
3. `R.recovery_pub` equals `K.recovery_pub` (no rotation in version 1).
4. Every device id is derived from its `auth`, the ids are distinct, there
   are 1 to 10 devices, at least one has `signer: true`, and every device
   has `server: true` or `client: true` (or both).
5. Every device listed in both `K` and `R` has the same `box` and `sign`
   keys in both (its `auth` is fixed by its id). Version 1 has no key
   rotation: a device with new keys enrolls again.
6. The signature checks out under the key named by `by`, and that key is
   trusted by `K`: either `by` is a device with `signer: true` in `K` (its
   `sign` key as listed in `K`), or `by` is `"recovery"` (the key
   `K.recovery_pub`).

The **cloud** also requires `R.prev = b64(SHA-256(K envelope bytes))` and
`R.version` to be the version in the request, so the stored history is one
chain. A **device** that was offline may see a roster several versions past
its `K` and cannot check `prev`; rules 5 and 6 are what it relies on. (A history
route that would let it check every link is later work; see section 9.)

The **genesis** roster has no `K`. It is valid when rules 1 and 4 hold,
`prev` is `null`, `version` is 1, it lists exactly one device, that device
is a signer and is `by`, and the signature checks out under that device's
`sign`. The device has the roles it chose; any kind of device may be
first (section 4.1).

What a roster means: the devices listed are the active devices; those with
`signer: true` may sign the next roster, and each device's roles say what
it may do in relay sessions (section 3.4). A device that is in `K` and not
in `R` was removed. A device must stop trusting a removed device at once:
close its sessions and refuse new ones.

### 3.3 What the cloud derives from a roster write

On `PUT /v1/roster` the cloud verifies the new roster against the current
one (section 3.2) and derives the change from the two device lists:

- **Added:** in `R`, not in `K`. Each must be a pending enrollment with
  `n_n` revealed, or an invitation candidate, and its `auth`, `box`, and
  `sign` must equal the enrollment's `auth_pub` and `pubs`. Its roles may
  only be the ones its `pubs` asked for or fewer: `server` may be `true`
  only if `pubs.server` is, and likewise `client`. A roster that gives an
  added device a role it did not ask for is refused (`invalid_roster`).
- **Removed:** in `K`, not in `R`. The revocation floor becomes the new
  version.
- **Signers:** the `signer` flags in `R`. The writer must be a signer in
  `K`, and `R` must keep at least one active signer.

The explicit fields of the request (`added_device_ids`, `added_signer_ids`,
`revoked_device_ids`) become optional; when present they must match what
the cloud derived.

A device that left by itself (`POST /v1/devices/self/leave`) is revoked
in the cloud's registry at once but stays in the signed roster until a
signer publishes one without it. Its listing in the meantime grants
nothing. Every device keeps a set of **departed** devices: the ids in the
`revoked` list of the relay's presence `roster` message, and the ids that
`GET /v1/devices` shows with `revoked_at`. It keeps only ids its verified
roster still lists (at most 9), stores the set on disk with its `K`, and
treats each as removed (section 3.2) on every route: it refuses new
sessions and closes live ones with 4001. An id leaves the set only when a
verified roster no longer lists it. A device that joins again has new keys
and a new id, so a departed id never comes back. Trusting the cloud here
is safe, because it can only take access away. A removal entry signed by
the leaving device is later work (section 9).

### 3.4 Roles in use

Roles change nothing in the cryptography; every device and the cloud
check them:

- A **host** runs its connector (presence socket and relay sessions) only
  while its own entry in its verified roster has `server: true`. A device
  without `server` runs no connector.
- A host accepts a relay session only from a device whose entry in its
  verified roster has `client: true` (section 5.1); otherwise it closes the
  session with 4002.
- A **controller** lists, and opens sessions to, only devices with
  `server: true` in its verified roster, and opens sessions only while its
  own entry has `client: true`.
- Letters (section 6) are not gated by roles.
- The **cloud** reads the roles from the roster it stores: it gives host
  presence and data endpoints only to `server` devices and controller
  sessions only to `client` devices. That is defense in depth; the
  devices' own checks are what the guarantee rests on.
- Roles change only by a new roster. In this version a device's roles are
  fixed when it joins: to change them, remove the device and add it again.

## 4. Joining an account

Every device starts the same way: the person signs in on it (the device
code flow, the API, section 1) and picks its roles. On a computer the
choice is **Use as server** and **Use as client**, both on by default; on
a phone **Use as client** is on and **Use as server** is shown but
disabled. Then:

- **First device** (4.1): on an account with no roster yet, any device
  (phone, desktop app, or `agentd cloud login`) runs genesis and is
  connected.
- **Glance and tap** (4.2), the default for every later device: the new
  device waits as a pending enrollment; each signer is told (section 4.5),
  shows the device's name, the roles it asked for, and the 6-digit code,
  and the person compares the code with the new device's screen and taps
  Approve.
- **Invitation** (4.3), the alternative: a signer shows a QR code or a
  link and the new device takes it. The new device needs no sign-in, and
  nobody compares a code.

The first device and glance and tap start with the device code flow,
which ends in a one-time enrollment session for this device. An
invitation claim is signed by the new device's own key instead (the API,
section 8). Signing in alone never adds a device: only a roster signed by
a signer does.

**Signer or member.** The first device is a signer. A later device with a
screen (a phone or the desktop app) is added as a signer by default; a
computer that runs only the CLI is added as a member. The person approving
may change that choice.

### 4.1 First device (genesis)

On an account with no roster (the confirm page told the user so), on any
device; a CLI asks the person to confirm before it goes on:

1. Make the recovery key. Show the recovery code and ask the user to save
   it. Do not continue until the user has typed back two of its groups, or
   confirmed by another explicit step.
2. Build the genesis roster (section 3.2): this device alone, a signer,
   with the roles the person chose and `recovery_pub`.
3. `POST /v1/enroll/genesis` with that roster and `recovery_sig`
   (the API). Then erase the recovery private key.

### 4.2 Commit-reveal and the 6-digit code

On an account with a roster, a new device `N` joins through a signer `A`.
The cloud relays every value; the code needs a secret it never sees.

1. **N** makes a random 32-byte `nN` and posts a pending enrollment with
   `pubs` (section 2.1, with the roles the person picked on N) and
   `commit = SHA-256(lines("agentd-commit-v1", b64(pubs bytes), b64(nN)))`.
2. **A** (any signer, on whichever the person opens the request) sees the
   pending entry, makes a random 32-byte `nA`, and posts it. The cloud
   records that `A` posted it (`n_a_by` in the pending object).
3. **N** reads `n_a` and `n_a_by`, fetches the roster, and takes `A`'s
   entry. `A` must be a signer there. N reveals `nN`.
4. **A** reads `n_n` and checks `commit`; on a mismatch it cancels the
   enrollment and tells the user.
5. Both compute the code from `A`'s `box` and `sign` (from the roster),
   `N`'s `pubs`, and the two nonces:

   ```
   dh   = X25519(own box private, other's box public)
   info = lines("agentd-code-v1", account_id, enrollment_id,
                A.id, b64(A.box), b64(A.sign),
                N.id, b64(N pubs bytes), b64(nA), b64(nN))
   okm  = HKDF-SHA256(ikm = dh, salt = empty, info, length = 4)
   code = (okm as a big-endian uint32) mod 1,000,000, as 6 digits with leading zeros
   ```

6. Both show the code, A next to the device's name, fingerprint, and the
   roles from N's `pubs`. The user confirms on A that the codes match. A
   then writes a roster that adds N with exactly the roles in N's `pubs`,
   or with one of them turned off if the person chose so (never one that
   `pubs` did not ask for, and at least one stays on), as a signer or a
   member (section 4, "Signer or member").
7. **N** waits for a roster that is valid after A's (section 3.2 with `K`
   the roster from step 3), lists N with its own keys, and is signed by A. That
   roster is now N's `K`.

Why the cloud cannot cheat: to add its own keys it must swap `pubs` (or
`A`'s keys) on one side, which changes `dh` on that side. It commits to
its fake `pubs` before seeing `nA`, so it matches the codes only by chance,
one in a million per attempt, and every attempt costs the user a visible
failed code. Without swapping, `dh` is a secret between the two devices, so
the cloud never learns the code.

### 4.3 Invitations (QR code or pasted link)

A signer `A` shows an invitation instead of the 6-digit flow:

1. A makes a random 16-byte `secret`, calls `POST /v1/invite` for a
   `slot_id`, and shows
   `agentd://invite?a=<account_id>&s=<slot_id>&k=<b64(secret)>` as a QR
   code or link. The secret never goes to the cloud.
2. The new device `N` claims the slot (the API, section 8) with
   `pubs` and
   `proof = HMAC-SHA256(secret, lines("agentd-invite-candidate-v1", account_id, slot_id, N.id, b64(auth_pub), b64(pubs bytes)))`.
3. A recomputes `proof` for each candidate from the pending entry, keeps
   the one that matches, drops the others, and writes a roster adding it
   with the roles from its `pubs` (or fewer, as in section 4.2, step 6).
   It then posts
   `confirm = HMAC-SHA256(secret, lines("agentd-invite-signer-v1", account_id, slot_id, N.id, version, b64(SHA-256(envelope bytes))))`
   for the new roster.
4. N reads `confirm`, fetches the roster, and checks `confirm` against that
   roster's version and envelope. N has no `K` yet, so `confirm` is what
   authenticates the roster: only A knows the secret. N also checks that
   the roster lists N with its own keys and that its signature is valid
   under the `sign` key of `by` as listed in it. It is now N's `K`.

**An invitation is a secret until it is used.** Anyone who sees the QR code
or the link before it is used or expires (10 minutes) can claim it with a
valid `proof`. So the signer:

- shows the QR code only while the user is adding a device, and offers the
  link only behind an explicit step that says it works like a password:
  send it only to the device being added;
- shows the candidate's fingerprint and kind, which the new device shows
  too, and adds it only once the user confirms;
- adds no candidate when more than one `proof` checks out, since someone
  else has the secret: it cancels the invitation (`DELETE
  /v1/invite/{slot_id}`), tells the user, and offers a new one.

### 4.4 Recovery

When no signer device is left, a new device posts a roster signed by the
recovery key (`by: "recovery"`), valid after the current one, that lists
the new device as a signer, with the request signature of
`POST /v1/enroll/recover` (the API). The user types the recovery code
on the new device, which derives the key, signs, and erases it.

### 4.5 Telling the signers

When a pending enrollment is created, the cloud sends every signer that
registered for push a notification with fixed text ("A device wants to
join your account") and an approval category, and nothing else: no
device name, no ids, no secrets. Tapping it opens the approval sheet,
which reads the pending enrollments with signed requests. A desktop app
that is a signer asks for pending enrollments every 30 seconds while it
runs and shows a system notification for a new one. Neither path changes
what is trusted: approval still needs the code comparison of section 4.2.

## 5. Relay sessions

A controller (for example the phone) opens a session to a host (a computer
or server running agents) as the API, section 6 describes. After
`paired`, every binary WebSocket message is one Noise message.

Sections 5.1 to 5.4 define the **session**: handshake, transport and
streams. They are the same whatever carries the Noise messages. A relay
session carries them in binary WebSocket messages through the relay; a
direct session (section 5.5) carries them over TCP. Each carrier sets the
prologue label, keepalive and flow control. Nothing else differs. Sessions
are separate from any other way a device's server may be reached (such as
a LAN listener with an access key): no credential of one is accepted by
the other.

**Text keepalive.** Besides WebSocket pings, every device sends the text
`ping` (those four characters, not JSON) on each of its relay sockets: the
host's presence socket and both ends of every data socket. It sends the
first as soon as the socket is open and then one every 25 seconds, also
while the relay has it paused (the API, "Flow control"). The relay answers
with the text `pong` on the same socket (it is never forwarded to the other
end), which the device does not parse as a message. The relay acts on the
time of the last `ping`: 70 seconds after it, a host is reported offline
(its presence socket), and a session is closed on both sides with 4013 (a
data socket). A device whose session closes with 4013 opens a new one at
once; `host_offline` then means the host is offline. A socket that has had
no frame at all (`pong`, protocol pong, or data) for 60 seconds is dead:
presence reconnects, and a data socket ends its session. A device also
ends a socket when the wall clock moved more than 60 seconds between two
of its checks (the machine slept), and, when the app comes back to the
front or the network changes, pings at once and ends a socket that does
not answer within 3 seconds. A quiet session's only frames are these
answers, so the text `pong` keeps it up where protocol pongs do not come
back. A relay from before the text keepalive closes the socket with 1003
(a data socket: the whole session): when that happens before any `pong`
came, the device reconnects and sends protocol pings only from then on, on
every socket.

### 5.1 Handshake

- **Pattern:** `Noise_IK_25519_AESGCM_SHA256` (Noise revision 34). The
  controller is the initiator and knows the host's `box` key from its
  verified roster; the host is the responder.
- **Prologue:**
  `lines("agentd-tunnel-v1", account_id, session_id, controller id, host id)`.
- **Static keys** are the devices' `box` keys.
- **Message 1** (controller to host) carries an empty payload. The host
  checks that the initiator's static key equals the `box` key of the
  `from` device of the offer in its own verified roster, and that the
  device is active and has `client: true` (section 3.4); otherwise it
  closes the session with 4002. The controller opens sessions only to a
  host with `server: true` in its verified roster.
- **Message 2** (host to controller) carries an empty payload.
- A message that fails to decrypt closes the session with 4002. No other
  message is allowed before the handshake ends.

### 5.2 Transport

- Each binary WebSocket message after the handshake is one Noise transport
  message: at most 65,535 bytes, so at most 65,519 bytes of plaintext.
  Nonces are the Noise counters; there is no rekey (a socket lives at most
  24 hours).
- Acks (the API, "Flow control") count the bytes of the binary
  WebSocket messages, ciphertext included. Ack at 256 KiB received or after
  500 ms without new bytes.
- When either side removes the other from its roster, it closes the
  session with 4001.

### 5.3 Streams

The plaintext is a **yamux** stream (version 0, the hashicorp/yamux spec):

- The controller opens streams with odd ids starting at 1. The host opens
  none in version 1.
- The initial window is 256 KiB. After a stream opens, each side grows its
  receive window to 2 MiB with one window update.
- Relay sessions send no yamux pings: WebSocket pings and the text
  keepalive keep them alive. Direct sessions send them (section 5.5).
  Every session answers a ping. Send Go Away before closing the session on
  purpose.
- One yamux frame may span several Noise messages and one Noise message may
  carry several yamux frames; joining writes is what keeps the message
  count low.

### 5.4 HTTP over a stream

Each stream carries one HTTP/1.1 exchange with the host's local OpenAgentd
server, byte for byte:

- The controller writes the request (`Host: localhost`,
  `Connection: close`) and closes its side (FIN) after the body. The host's
  connector forwards the exchange to its local server over a dedicated path
  that the server knows to be the relay, never a connection the server
  would treat as a local caller, and closes its side when the server
  closes. The request is authenticated as the session's roster device.
- Before forwarding, the connector removes `Authorization`, `Cookie`,
  `Origin`, `Forwarded`, `X-Forwarded-*`, `Via`, and `Accept-Encoding`:
  credentials and proxy hints come only from the session, never from the
  controller.
- Event streams (SSE) and WebSocket upgrades are the same: the stream stays
  open while the exchange lasts.
- The connector must not compress: the relay sees the size of every
  frame, and compressed sizes leak content.
- The controller answers CORS preflights (`OPTIONS`) itself.
- The connector drops SSE comment lines (`: ping`) instead of forwarding
  them; the controller keeps the event source alive on its side.
- Writes are joined into one message: a sender waits 2 ms after the first
  waiting byte, or until 65,519 bytes wait, whichever comes first.
  Messages smaller than 65,519 bytes are limited to 20 a second with a
  burst of 8: once the burst is spent, the sender keeps joining until the
  next message is allowed (at most 50 ms later). A full message is sent at
  once and does not count. The rule is local to the sender, so devices
  with and without it work together.
- The controller's streams are taken in turn: frames without data
  (opens, window updates) go first, then one frame of each stream with
  data waiting, so a large transfer does not hold a small request back.
- The connector sends requests only to its own local server. A request it
  cannot parse, or one for another host, gets `400` and the stream closes.

### 5.5 Direct sessions

A controller and a host on the same private network may run a session
over TCP instead of the relay: a **direct session**. Keys, roles,
handshake pattern and streams are those of a relay session. Only the
carrier changes, and what belonged to the relay goes away. The cloud
takes no part in it and learns nothing about it.

**Who.** The controller dials a host only when the host has
`server: true` in its verified roster and is not departed (section 3.3),
and its own entry has `client: true`. The host accepts a controller only
when that controller's static key is the `box` key of an entry in its
verified roster with `client: true`, that is not the host itself and is
not departed.

**Addresses.** A host tells controllers where to reach it only inside an
established session, relay or direct. Its server answers
`GET /api/cloud/direct` for the session's device, and for no other
caller, with

```json
{"v":1,"on":true,"port":4181,"addrs":["192.168.1.20","fd12:3456::20"]}
```

or `{"v":1,"on":false}`. `addrs` are the host's private addresses: at
most 8, IPv4 in dotted form, IPv6 with no zone. **Private** means
10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 and fc00::/7, with IPv4-mapped
IPv6 read as IPv4. The controller accepts only private addresses, stores
the answer under the host's device id together with the network it was
on, replaces it on every answer, and dials those addresses only for that
host, and only while it is on that network again (for example, the same
local subnet). Addresses are never taken from anywhere else, such as a
saved server.

**Listener.** The host listens on `port`, on its private addresses only.
It accepts a connection only when both the local and the peer address are
private. It holds at most 16 connections that have not finished the
handshake, at most 4 from one peer address, and closes new ones beyond
that. It closes a connection that has not delivered message 1 within 5
seconds of accepting it. It listens only while all of these hold: the
person's setting is on (the default for a device with `server: true`),
its own entry has `server: true`, the account is neither closing nor
deleted, the device has no unconfirmed removal signal, and its last
contact with the cloud (below) is less than 7 days old.

**Greeting and framing.** The controller connects and sends the 17 ASCII
bytes `agentd-direct-v1\n` (ending in 0x0A). The host closes the
connection at once on any other bytes, before any key work. After the
greeting, every message in either direction is a 2-byte big-endian length
`L` followed by one Noise message of `L` bytes. Message 1 has `L = 96`,
message 2 has `L = 48`, and transport messages have `16 ≤ L ≤ 65,535`.
Any other length closes the connection.

**Handshake.** As in section 5.1, with the prologue

```
lines("agentd-direct-v1", account_id, host id)
```

There is no offer. The host finds the controller by the static key in
message 1: the roster entry whose `box` equals it. If more than one entry
has that `box`, the host refuses. It runs the checks of section 5.1 on
that entry, plus the departed set. If a check fails, or message 1 does
not decrypt, the host closes the connection without sending anything.
After message 2 the connection is still an unfinished handshake (it
counts toward the listener's limits) until the host has decrypted a
transport message on it; the host closes it, with nothing sent, if none
arrives within 5 seconds of message 2. The controller's first ping
(below) is that message. A controller treats a close or a timeout (2 seconds)
before message 2 as "not reachable directly", and stays on or moves to
the relay. Only the host whose `box` key the controller used can read
message 1 or write message 2, so a different machine at a remembered
address learns nothing and gets nothing.

**Transport and streams.** Sections 5.2 to 5.4 apply, with these changes.
There are no acks, pause or resume (the API's "Flow control"): TCP holds
back a fast sender. The 2 ms join of section 5.4 applies, but not its
limit of 20 messages a second, which protects the relay's allowance. Both
sides turn Nagle off (`TCP_NODELAY`). There is no rekey: a host ends a
direct session after 24 hours (Go Away 0), and the controller opens a new
one.

**Keepalive.** Each side sends a yamux ping (type 2, flag SYN, stream 0,
a counter in the length field) as soon as the handshake ends and then
every 25 seconds. The other side answers with ACK and the same value. A
side closes the session when it has received no message for 60 seconds,
or when its wall clock has moved more than 60 seconds further than its
monotonic clock since the last message (the device slept). When a
controller comes back to the foreground or its network changes, it pings
at once and closes the session if nothing arrives within 3 seconds.

**Closing.** Before it closes on purpose, a side sends a yamux Go Away
whose length field carries the reason: `0` normal (including the setting
turned off, the 24 hours, the 7-day rule, a shutdown, or a newer session
replacing this one), `4001` the controller was removed (section 3.2), or
`4011` the host's account is closing. Then it closes the TCP connection.
A transport message that does not decrypt, or whose plaintext is not
valid yamux, closes the connection at once with nothing sent (what 4002
is on the relay). Reasons `1` (protocol error) and `2` (internal error)
are accepted from a peer but not sent in this version. A controller
handles Go Away 4001 as it handles a relay 4001, and any other reason,
4011 included, as a lost route: on a direct session 4011 is one device's
word, and only the cloud says the account is closing ("Account state",
section 1). No new
close code is added on the relay.

**Limits.** A host keeps at most 8 direct sessions per controller and 32
in all. A session counts toward these limits, and can replace an older
one, only once the host has decrypted a transport message on it, so a
replayed message 1 neither counts nor replaces anything. When a 9th
session from one controller gets that far, the host closes that
controller's oldest session (Go Away 0), because a phone that changed
networks leaves dead sessions behind.

**Last contact with the cloud.** A host records the wall-clock time of
its last contact with the cloud: a signed roster fetch that returned a
roster it verified (or no newer one), followed by a successful
`GET /v1/devices`. It makes that contact at every (re)connection to the
relay and on every presence `roster` message, at most once a minute.
After 7 days with no contact, it stops accepting direct sessions and ends
live ones with Go Away 0, until the next contact. That limits how long a
device removed while the host was cut off can still reach it.

## 6. Mailbox letters

A letter (the API, section 7) is sealed by the sender `S` to the
recipient `R`, both active devices of the account:

```
e      = a fresh X25519 key pair
ikm    = X25519(e, R.box) || X25519(S.box, R.box)
info   = lines("agentd-letter-v1", account_id, S.id, R.id, kind, b64(e.public))
okm    = HKDF-SHA256(ikm, salt = empty, info, length = 44)
key    = okm[0..32], nonce = okm[32..44]
sealed = e.public || AES-256-GCM(key, nonce, aad = empty, plaintext)
```

`sealed` is exactly 256, 512, 1024, or 2048 bytes, the smallest that fits,
so the plaintext is that size minus 48 bytes:

```
plaintext = uint16 big-endian length of J || J || zero bytes to the size
J         = {"v":1,"title":"...","body":"...","session":"<optional id>","at":<ms>}
```

The recipient takes `S` from the letter's `from`, looks up `S.box` in its
verified roster, recomputes the key, and drops a letter that does not open
or whose `kind` does not match the outer one. The static-static term binds
the sender, so the cloud cannot forge a letter. The text shown in a
notification comes from `J`, never from the outer fields.

## 7. Device kind

Optional and self-reported (the API, "Conventions"). It never enters
the roster and never gates anything.

## 8. Test vectors

`tunnel_vectors.json` has one object per section. Each case gives the
inputs (fixed private keys as b64 seeds, fixed random values) and the exact
outputs:

| Key | Covers |
|---|---|
| `device_id` | `auth` public key to device id and fingerprint |
| `recovery_code` | Seed to recovery code and back |
| `pubs` | The `pubs` bytes, with each device's roles |
| `roster` | Genesis, an add, a removal, a recovery; envelopes, hashes, signatures; and invalid rosters with the rule they break (including a device with no role, missing or non-boolean roles, and a version 1 body) |
| `code` | Commit and the 6-digit code, from both sides |
| `invite` | `proof` and `confirm` |
| `noise` | A full IK handshake and two transport messages each way |
| `direct` | The greeting bytes; the direct prologue; a full IK handshake with that prologue, as framed bytes (length prefix included); two framed transport messages each way; a yamux ping SYN and its ACK, and a Go Away 4001, as plaintext and as framed ciphertext; framing that must be refused: lengths 0, 15 and 97 for message 1, 0, 47 and 49 for message 2, and 0 and 15 for a transport message |
| `letter` | A sealed letter at each size, and its plaintext |

An X25519 or Ed25519 private key is given as its 32-byte seed. In
WebCrypto it is imported as PKCS#8: the 16 bytes
`302e020100300506032b656e04220420` (X25519) or
`302e020100300506032b657004220420` (Ed25519), then the seed.

## 9. Later

- `GET /v1/roster/history` so an offline device can check every link.
- A removal entry signed by a device that leaves on its own.
- Signer keys held in hardware (P-256 in the Secure Enclave or StrongBox),
  as a second signature type.
- Recovery key rotation.
- Changing a device's roles without removing and adding it again.
- Host-opened streams (for example the host asking the controller for a
  file).
- Direct sessions across the internet.
- Finding hosts without the relay (mDNS).
- A controller handing a host a newer signed roster when the host cannot
  reach the cloud.
