# Install the OpenAgentd Android app

The Android app connects to an OpenAgentd server running on another computer.
The server holds your agents, sessions, and keys. The app doesn't run a
backend of its own.

OpenAgentd isn't on Google Play. Each release includes an `.apk` you install
directly.

## Requirements

- An Android phone or tablet running Android 7.0 or later with a 64-bit ARM
  processor. Nearly every phone sold since about 2017 qualifies.
- An up-to-date **Android System WebView**, which updates through Google Play.
- An OpenAgentd server the phone can reach (see [Connect to your server](#connect-to-your-server)).

## Install

1. On the phone, download `OpenAgentd_<version>_Android.apk` from the
   [latest release](https://github.com/lthoangg/openagentd/releases/latest).
   You can also download `OpenAgentd_<version>_Android.apk.sha256` and check the
   file on a computer:

   ```bash
   shasum -a 256 -c OpenAgentd_<version>_Android.apk.sha256
   ```

2. Open the downloaded APK. If Android asks, allow your browser or file
   manager to **Install unknown apps**, then go back and tap **Install**.
3. If Google Play Protect warns about an unknown app, tap **More details →
   Install anyway**. The warning shows for any app that isn't from Google Play.
4. Open **OpenAgentd** from the app drawer.

With a computer and USB debugging on, you can also run
`adb install -r OpenAgentd_<version>_Android.apk`.

## Update

From v3.49.0 the app checks for updates itself. When a new version is out, a
card offers **Download** and then **Install**; you can also check from
**Settings → About OpenAgentd → Updates**. The first time, Android asks you to
allow installs from OpenAgentd: turn it on, go back, and tap **Install** again.

You can still update by hand: download the newer APK and open it. Either way
Android installs it over the existing app and keeps your saved servers and
access keys. Every release is signed with the same key; Android refuses an
update signed with a different one.

## Connect to your server

On the computer that runs OpenAgentd, start a server the phone can reach:

```bash
agentd server start --public --key --qr
agentd server status
```

`--public` listens on every network interface, and `--key` prompts you to choose
the access key every client must send; the server refuses to listen on the
network without one. `--qr` prints a QR code: scan it with the phone's camera to
open the app's **Computers** screen with the address and key filled in, then
tap **Connect**. `agentd server status --qr` shows it again.
If OpenAgentd isn't installed yet, see
[CLI server](../README.md#cli-server).

In the app:

1. Open the **Computers** screen (the app starts on it until a computer is
   connected; later it is one step back from Sessions) and tap **Add a
   computer by address**.
2. Enter the server's LAN address, for example `http://192.168.1.20:4082`, and
   the access key.
3. Tap **Connect**. The key is encrypted with a key held in the Android
   Keystore.

The server has no built-in TLS. To reach it from outside a trusted network, put
an HTTPS reverse proxy (or a private network such as a VPN) in front of it, and
connect to that address instead.

## Remote control

With an OpenAgentd account the app reaches your computers away from home
too, and tells you when an agent is done or needs you. It's optional:
everything above works without it. It needs Android 11 or later and a screen
lock (a PIN, pattern or password).

1. Open the app. A phone that isn't in an account shows a QR code: scan it
   with your other phone (**Scan** on its Computers screen), or tap **No
   other phone nearby? Sign in with Google**.
2. If this is your first device, the app shows a recovery code once. Save it
   in a password manager and type back the two groups it asks for.
3. To add a computer, open **Settings → Remote control** on it and scan its
   code with **Scan QR code** on the phone's Computers screen.

The account's keys are made on the phone and stay in the Android Keystore.
Adding, approving or removing a device asks for your fingerprint or your
screen lock every time. If you turn the screen lock off, Android deletes
that key: the phone stays in your account and still opens your computers,
but another phone has to add devices from then on. Signing out erases the
keys.

Notifications: allow notifications for OpenAgentd when Android asks. Each kind
(Done, Needs you, Failed, Devices asking to join) has its own channel under
**Settings → Apps → OpenAgentd → Notifications**, so you can mute one. The
lock screen shows "New activity" unless you allow sensitive notifications
there. Some phones' battery savers hold notifications back; set OpenAgentd's
battery use to **Unrestricted** if they arrive late.

## Home-screen widgets

Touch and hold an empty spot on the home screen, tap **Widgets**, and find
OpenAgentd. There are three:

- **Quick start** (2×2): continue your last session, or start a new one in
  your last folder.
- **Sessions** (4×2): up to three sessions, the ones that need you first, then
  the ones still running, then recent ones.
- **Next task** (2×2): your next scheduled task and whether its last run
  passed. Tapping it opens the scheduler on that task.

The widgets show what the app knew the last time it was open, with an "as of"
time. Open the app to refresh them. After 30 minutes, "Needs you" and
"Running" turn into plain ages, because the session may have moved on. The
widgets never store the server address or access key.

## Troubleshooting

| Problem | Fix |
|---|---|
| "App not installed" on a fresh install | The phone runs a 32-bit system, which this APK doesn't support, or the download is incomplete. Check the `.sha256`. |
| "App not installed" when updating | The installed copy was signed with a different key, such as a local developer build. Uninstall it, then install the release APK. You'll need to add your servers again. |
| The app can't reach the server | Check that the phone and the computer are on the same network and the server was started with `--public --key`. Turn off mobile data to rule out the phone leaving Wi-Fi. |
| "Unauthorized" when connecting | The access key doesn't match. Re-enter the key you chose, or set a new one with `agentd server restart --public --key`. |
| The app asks for the access key again after restoring a backup or moving to a new phone | Expected. The encryption key stays on the original device, so re-enter the access key. |
| The screen is blank or looks broken | Update **Android System WebView** and **Chrome** in Google Play. |
| Tapping a widget does nothing | Android cancels a widget's taps when the app is force-stopped. Open the app once and the widgets work again. |
| "Set a screen lock on this phone to use an OpenAgentd account" | Remote control needs a PIN, pattern or password. Set one in Android's settings, then try again. |
| "Accounts need Android 11 or later" | Remote control isn't available on this phone. Connect to your server by address instead. |
| "This phone can't add devices any more" | The screen lock was turned off, which removed the key that adds devices. Add devices from another phone; this one still opens your computers. |
| "Push notifications are not set up in this build" | A build made without Firebase settings, such as a local developer build. Install the release APK. |
