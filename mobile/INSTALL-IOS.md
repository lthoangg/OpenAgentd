# Install the OpenAgentd iOS app

The iOS app connects to an OpenAgentd server running on another computer. The
server holds your agents, sessions, and keys; the app does not run a backend of
its own.

Install it from the **App Store**. If you want new versions before they reach
the App Store, join the public beta on **TestFlight** instead.

A phone or iPad has one or the other: installing either one replaces the
other.

## Install from the App Store

1. On your iPhone or iPad, open
   [OpenAgentd on the App Store](https://apps.apple.com/app/openagentd/id6831600179).
2. Tap **Get**. The app is free.

## Join the public beta on TestFlight

The beta gets early builds of the next version.

1. Install [TestFlight](https://apps.apple.com/app/testflight/id899247664)
   from the App Store.
2. On your iPhone or iPad, open the
   [OpenAgentd public beta link](https://testflight.apple.com/join/rykJnzxZ),
   and tap **Accept**, then **Install**.

## Updates

- **App Store:** updates come through the App Store. To get them
  automatically, turn on **App Updates** in **Settings → App Store**.
- **TestFlight:** new beta builds appear in TestFlight; turn on **Automatic
  Updates** there. Each beta build expires after 90 days, so keep installing
  the newer ones.

## Requirements

- An iPhone or iPad running iOS/iPadOS 15.0 or later.
- An OpenAgentd server the phone can reach (see
  [Connect to your server](#connect-to-your-server)).

## Connect to your server

On the computer that runs OpenAgentd, start a server the phone can reach:

```bash
agentd server start --public --key --qr
agentd server status
```

`--public` listens on every network interface, and `--key` prompts you to choose
the access key every client must send; the server refuses to listen on the
network without one. `--qr` prints a QR code: scan it with the phone's camera to
open the app's **Server** dialog with the address and key filled in, then tap
**Test** and **Save and use**. `agentd server status --qr` shows it again.
If OpenAgentd is not installed yet, see
[CLI server](../README.md#cli-server).

In the app:

1. Open **Settings → Server** (or **Choose server** on the start screen) and
   tap **Add a server**.
2. Enter the server's LAN address, for example `http://192.168.1.20:8000`, and
   the access key.
3. When iOS asks to find devices on your local network, tap **Allow**.
4. Tap **Test**, then **Save and use**. The key is stored in the iOS Keychain.

The server has no built-in TLS. To reach it from outside a trusted network, put
an HTTPS reverse proxy (or a private network such as a VPN) in front of it, and
connect to that address instead.

## Home-screen widgets

Touch and hold the Home Screen, tap **Edit → Add Widget**, and search for
OpenAgentd. There are three:

- **Quick start** (small or medium): start a new session in your last folder.
  The medium size also continues your last session.
- **Sessions** (medium): up to three sessions, the ones that need you first,
  then the ones still running, then recent ones.
- **Next task** (small): your next scheduled task with a countdown, and
  whether its last run passed. Tapping it opens the scheduler on that task.

The widgets show what the app knew the last time it was open, with an "as of"
time. Open the app to refresh them. After 30 minutes, "Needs you" and
"Running" turn into plain ages, because the session may have moved on. The
widgets never store the server address or access key.

## Troubleshooting

| Problem | Fix |
|---|---|
| The widgets say "Open OpenAgentd to load your sessions" | Open the app once while it is connected to a server. |
| The app cannot reach the server | Check that the phone and the computer are on the same network and the server was started with `--public --key`. Make sure **Settings → Privacy & Security → Local Network → OpenAgentd** is on. |
| "Unauthorized" when connecting | The access key does not match. Re-enter the key you chose, or set a new one with `agentd server restart --public --key`. |
