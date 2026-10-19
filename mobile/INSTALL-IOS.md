# Install the OpenAgentd iOS app

The iOS app connects to an OpenAgentd server running on another computer. The
server holds your agents, sessions, and keys; the app does not run a backend of
its own.

OpenAgentd is not on the App Store. Each release includes an `.ipa` you can
sideload. The recommended tool is [SideStore](https://sidestore.io), which
signs the app with your own Apple Account.

## Requirements

- An iPhone or iPad with a passcode, running iOS/iPadOS 15.0 or later.
- A computer running macOS, Windows, Linux, or ChromeOS. You need it once, to
  install SideStore.
- An Apple Account. A free account works (see [Free Apple Account limits](#free-apple-account-limits)).
- Wi-Fi.
- An OpenAgentd server the phone can reach (see [Connect to your server](#connect-to-your-server)).

## Option A: SideStore with the OpenAgentd source (recommended)

Adding the source lets SideStore show new OpenAgentd versions as updates.

1. Set up SideStore by following its official guide:
   [prerequisites](https://docs.sidestore.io/docs/installation/prerequisites),
   then [install](https://docs.sidestore.io/docs/installation/install). In short:
   - install **LocalDevVPN** from the App Store;
   - install **iloader** on your computer and use it to install SideStore over USB;
   - trust your Apple Account under **Settings → General → VPN & Device Management**;
   - on iOS 16 and later, turn on **Settings → Privacy & Security → Developer Mode**.
2. Open LocalDevVPN and tap **Connect**. SideStore needs this VPN whenever it
   installs, updates, or refreshes an app.
3. In SideStore, open **Sources**, tap **+**, and add:

   ```text
   https://github.com/lthoangg/openagentd/releases/download/latest-ios/source.json
   ```

4. Open the OpenAgentd source and tap **Get** (or **Free**) on OpenAgentd.
5. Open OpenAgentd from the Home Screen.

When a new version is released, it shows up under **My Apps** in SideStore.
Tap **Update** with LocalDevVPN connected.

## Option B: install the IPA manually

1. Download `OpenAgentd_<version>_iOS.ipa` from the
   [latest release](https://github.com/lthoangg/openagentd/releases/latest).
   You can also download `OpenAgentd_<version>_iOS.ipa.sha256` and check the
   file on a computer:

   ```bash
   shasum -a 256 -c OpenAgentd_<version>_iOS.ipa.sha256
   ```

2. Save the IPA to the Files app on your device.
3. With LocalDevVPN connected, open SideStore → **My Apps**, tap **+**, and
   choose the IPA.

To update, repeat these steps with the newer IPA. SideStore installs it over the
existing app and keeps your data.

## Other sideloading tools

The IPA is ad-hoc signed and has no entitlements, so any tool that re-signs apps
can install it:

- **AltStore Classic**: add the same source URL as in Option A.
- **Sideloadly**: install from a computer over USB or Wi-Fi.
- **TrollStore**: installs it permanently, but only on the iOS versions
  TrollStore supports.

## Free Apple Account limits

Apple sets these limits for apps signed with a free Apple Account. Every
sideloading tool is subject to them:

- **Apps expire after 7 days.** SideStore refreshes them in the background
  while LocalDevVPN is connected. If an app is about to expire, open SideStore
  and tap the days counter next to it under **My Apps**. An expired app does
  not open until you refresh it; its data is kept.
- **At most 3 sideloaded apps at once**, SideStore included.
- **At most 10 App IDs per 7 days.** Installing and removing apps repeatedly
  can use them up.
- SideStore may add a suffix to the app's bundle identifier for your account.
  This is expected and does not affect the app.

A paid Apple Developer account extends expiry to one year and removes the app
limit.

## Connect to your server

On the computer that runs OpenAgentd, start a server the phone can reach:

```bash
agentd server start --public --key --qr
agentd server status
```

`--public` listens on every network interface, and `--key` prompts you to choose
the access key every client must send; the server refuses to listen on the
network without one. `--qr` prints a QR code: scan it with the phone's camera to
open the app's **Backend connection** dialog with the address and key filled in,
then test and save the connection. `agentd server status --qr` shows it again.
If OpenAgentd is not installed yet, see
[CLI server](../README.md#cli-server).

In the app:

1. Open **Backend connection**.
2. Enter the server's LAN address, for example `http://192.168.1.20:8000`, and
   the access key.
3. When iOS asks to find devices on your local network, tap **Allow**.
4. Test the connection, then save it. The key is stored in the iOS Keychain.

The server has no built-in TLS. To reach it from outside a trusted network, put
an HTTPS reverse proxy (or a private network such as a VPN) in front of it, and
connect to that address instead.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Untrusted Developer" when opening an app | Trust your Apple Account under **Settings → General → VPN & Device Management**. |
| The app will not open after about a week | It expired. Connect LocalDevVPN and refresh it in SideStore → **My Apps**. |
| SideStore cannot install or refresh | Connect LocalDevVPN and use Wi-Fi. For pairing-file errors, follow SideStore's [pairing file guide](https://docs.sidestore.io/docs/advanced/pairing-file). |
| SideStore says the app's permissions do not match | Remove the source, add it again, and retry. If it still fails, [open an issue](https://github.com/lthoangg/openagentd/issues). |
| The app cannot reach the server | Check that the phone and the computer are on the same network and the server was started with `--host 0.0.0.0 --key`. Make sure **Settings → Privacy & Security → Local Network → OpenAgentd** is on. |
| "Unauthorized" when connecting | The access key does not match. Re-enter the key you chose, or set a new one with `agentd server restart --public --key`. |

For SideStore-specific problems, see the
[SideStore documentation](https://docs.sidestore.io) and its community channels.
