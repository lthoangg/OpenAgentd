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

Download the newer APK and open it. Android installs it over the existing app
and keeps your saved servers and access keys. Every release is signed with the
same key; Android refuses an update signed with a different one.

## Connect to your server

On the computer that runs OpenAgentd, start a server the phone can reach:

```bash
openagentd server start --host 0.0.0.0 --key
openagentd server status
```

`--key` prompts you to choose the access key every client must send. The server
refuses to listen on the network without one. If OpenAgentd isn't installed yet, see
[CLI server](../README.md#cli-server).

In the app:

1. Open **Backend connection**.
2. Enter the server's LAN address, for example `http://192.168.1.20:8000`, and
   the access key.
3. Test the connection, then save it. The key is encrypted with a key held in
   the Android Keystore.

The server has no built-in TLS. To reach it from outside a trusted network, put
an HTTPS reverse proxy (or a private network such as a VPN) in front of it, and
connect to that address instead.

## Troubleshooting

| Problem | Fix |
|---|---|
| "App not installed" on a fresh install | The phone runs a 32-bit system, which this APK doesn't support, or the download is incomplete. Check the `.sha256`. |
| "App not installed" when updating | The installed copy was signed with a different key, such as a local developer build. Uninstall it, then install the release APK. You'll need to add your servers again. |
| The app can't reach the server | Check that the phone and the computer are on the same network and the server was started with `--host 0.0.0.0 --key`. Turn off mobile data to rule out the phone leaving Wi-Fi. |
| "Unauthorized" when connecting | The access key doesn't match. Re-enter the key you chose, or set a new one with `openagentd server start --host 0.0.0.0 --key`. |
| The app asks for the access key again after restoring a backup or moving to a new phone | Expected. The encryption key stays on the original device, so re-enter the access key. |
| The screen is blank or looks broken | Update **Android System WebView** and **Chrome** in Google Play. |
