---
name: oad/ios-store
description: OpenAgentd iOS distribution — TestFlight Internal and Public Beta builds from CI, App Store Connect setup and secrets, triaging a failed release-ios run, Beta App Review and App Store submission (review notes, demo video, screenshots, privacy). Use when shipping, debugging, or submitting the iOS app.
---

iOS ships only through App Store Connect, from `.github/workflows/release-ios.yml`,
never from a local Mac. One binary goes to TestFlight and, once tested, unchanged
to the App Store. The app has no in-app update check: TestFlight and the App Store
deliver updates. Version releases (tag, desktop, Android) follow `oad/release`.

## 1. Channels

| Channel | How | Environment |
|---|---|---|
| Dev | `make -C mobile ios-install-device <name>` on your own device | none |
| Internal | `gh workflow run release-ios.yml --ref <branch> -f channel=internal` from any branch | `testflight-internal` (no reviewers, all branches) |
| Public Beta | `gh workflow run release-ios.yml --ref v<X.Y.Z> -f channel=public -f confirm=release-ios` | `release-ios` (maintainer approval; `main` and `v*`) |
| App Store | in App Store Connect, submit the tested Public Beta build of X.Y.Z for review | none |

- The Internal group has access to every build, including public ones, with no
  review. `mobile/scripts/asc-public-beta.py` adds a public build to the
  "Public Beta" group and submits it for Beta App Review.
- The `build` job has no secrets (`cargo tauri ios build --archive-only --no-sign`);
  only `sign` signs (`mobile/scripts/sign-ipa-appstore.sh`), validates with
  `altool --validate-app`, and uploads. Never give `build` a secret or an
  `environment:` (`scripts/tests/test_release_signing_isolation.py`).
- Build number = workflow run number, so uploads never clash. The version comes
  from `appv3/Cargo.toml`. Once Apple approves X.Y.Z on the App Store its train
  closes and the run stops with "bump the version" (`scripts/bump_version.sh`).
  Beta App Review does not close a train.
- Away from the Mac, the maintainer can ask the agent (through the OpenAgentd
  app) to dispatch the Internal command for a branch.
- Timing: about 20 min build cold (less with the Rust cache), 3–5 min sign, then
  5–30 min Apple processing before TestFlight shows the build.
- Public TestFlight builds expire after 90 days: ship a public build at least
  that often.

## 2. When a run fails

```bash
gh run view <id> --json jobs -q '.jobs[] | "\(.name): \(.status) \(.conclusion)"'
gh run view <id> --log-failed | sed 's/^[^Z]*Z //' | grep -iE "error|FAILED"
```

Fix on the branch, push, dispatch again. The Rust cache is kept on failure, so a
retry is faster. Apple's bundle rules only surface in `sign` at
`altool --validate-app`, about 20 minutes in: check `Info.ios.plist`,
entitlements and `PrivacyInfo.xcprivacy` edits against them before pushing.
Known rules:

- `UISupportedInterfaceOrientations~ipad` must list all four orientations while
  the iPad app supports multitasking (error 90474).
- Every bundle that calls a required-reason API needs its own privacy manifest
  (ITMS-91053, reported by email after upload). The widget extension today only
  reads a file from the App Group and needs none.

A build that uploaded but is missing from TestFlight: check its processing
state and the tester's invitation (an internal tester stays `INVITED` until
they accept the email) through the App Store Connect API before changing code.

A public run that uploaded its build and then failed in
`Add to the Public Beta group and submit for Beta App Review`: do not dispatch
`release-ios.yml` again, since every run uploads another build. Send the build
that is already there (its build number is that run's number), then approve
`release-ios`:

```bash
gh workflow run publish-ios-beta.yml --ref main -f version=<X.Y.Z> -f build=<run number> -f confirm=release-ios
```

Apple can list a build as processed minutes before its TestFlight calls know
it, and answers 404 for the build until then. `asc-public-beta.py` waits up
to 15 minutes for that; a failure after it prints the state Apple has the
build in.

## 3. App Store Connect calls

- Read state first; for anything that changes it (groups, review submission,
  metadata), show the planned change, then apply it.
- Select a build by version and build number, never "latest": right after an
  upload, "latest" can still be the previous build.
- Never create a second review submission for a version that already has one;
  inspect the existing one.
- Contact details and other personal data go only into App Store Connect, never
  into the repository, commits, or CI logs.

## 4. Setup and secrets

Apple: App IDs `com.openagentd.mobile`, `com.openagentd.mobile.widgets` and
`com.openagentd.mobile.notifications` (the Notification Service Extension that
opens OpenAgentd Cloud notifications), all with the App Group
`group.com.openagentd.mobile`, and Push Notifications on the app; one *App
Store* profile for each; an App Store Connect record with an Internal group (automatic
distribution on) and an external group `Public Beta` with a public link
(linked from openagentd.dev/download/ios).

The same secrets in `testflight-internal` and `release-ios`
(`gh secret set <NAME> --env <environment>`):

| Secret | Value |
|---|---|
| `IOS_DIST_CERTIFICATE` / `_PASSWORD` | base64 of the Apple Distribution `.p12` / its password |
| `IOS_PROFILE_APP` / `IOS_PROFILE_WIDGET` / `IOS_PROFILE_NOTIFICATIONS` | base64 of the three App Store `.mobileprovision` files |
| `ASC_API_KEY` / `ASC_API_ISSUER` | App Store Connect API key ID / issuer ID (role *App Manager*) |
| `ASC_API_KEY_P8` | contents of `AuthKey_<id>.p8` |
| `KEYCHAIN_PASSWORD` | any random string |

- Renewal: profiles and the Distribution certificate expire after a year;
  regenerate the profiles (they must name the current certificate) and replace
  the secrets. A build already on TestFlight keeps its 90 days.
- Leak: revoke the certificate or API key in the Apple portals, then replace
  the secrets. Installed apps keep working.

## 5. Review: Beta App Review and App Store

There is no shared demo server: every OpenAgentd server is private. Reviewers
get notes plus a demo video. Only if Apple insists on hands-on access, run a
temporary instance (sample data, a throwaway spending-limited model key) behind
a temporary HTTPS tunnel for the review window, then shut it down. Never expose
a maintainer's own server.

Review Notes (App Store) and Test Information (Beta App Review) cover:

- the app is a client for the user's own OpenAgentd server, with no account and
  no hosted backend;
- 3–5 numbered steps to try it: install the server, Settings → Connection →
  Connect a device → Show QR, then Scan QR code in the app, accept the AI-data
  consent, send a message;
- the native parts (QR pairing, widgets, share sheet, photo and
  file pickers), since a thin web wrapper is rejected under 4.2/4.3;
- plugins and MCP servers run on the server; the app runs no downloaded code
  outside WebKit;
- the demo video link.

Demo video: record the real app on the simulator (`xcrun simctl io booted
recordVideo`) against a separate seeded server, never one with real data; burn
in short English captions with `ffmpeg`; 1–2 minutes covering pairing, chat,
plan review, and the native parts. The simulator has no camera: show the QR on
the server and pair by address, captioned. Footage must be the real app, not
mockups.

App Store only (not needed for TestFlight):

- Screenshots: `make -C mobile ios-screenshots` (iPhone 6.9" and iPad 13") against
  a seeded server; check each image. Real UI only, short factual captions.
- URLs: Privacy `https://openagentd.dev/privacy/`, Support
  `https://openagentd.dev/support/`. The app links Privacy in About.
- App Privacy: Data Not Collected, matching `mobile/src-tauri/PrivacyInfo.xcprivacy`
  and the site. Fill the Accessibility labels.
- The store description has no "beta" wording and no other platforms' stores.
- Avoid submitting December 20–27 (holiday freeze) and right after a major iOS
  release; plan for one rejection round.
- If rejected: answer in the Resolution Center with facts and the guideline
  number; appeal to the App Review Board only after that.
