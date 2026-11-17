---
title: "Features: The app: phones and tablets"
description: "The phone layout and the iOS and Android apps: navigation, typing, widgets, and store channels."
---

# The app: phones and tablets

Part of the [feature catalogue](../features.md), under *1. The desktop coding workspace*. The index explains the version tags.

- **Phone polish** `[v3.37.0]` — the phone drawer footer names the connected
  server next to its dot, and the phone header shows the context ring, so
  context use is one glance away. At 320–375 px, model IDs, provider and
  session names, file paths and tool summaries stay readable instead of
  collapsing to a few letters; crowded toolbars (Plan, Preview, Git, the
  review panel) move rare actions into a `⋯` menu; the composer's controls
  and the split Steer pill share one 36 px height; and in a phone browser a
  session's More button opens a sheet with its full title. Toasts sit below
  the header. The Git Changes / History tabs stay inside their toolbar on a
  phone, and a commit with several branch or tag labels keeps its date in
  view.
- **Toolbar controls fit on touch** `[v3.39.0, v3.40.0]` — on a touch screen the
  review panel's view toolbar keeps its 32px height: the Rendered / Source
  switch and the icon actions (download, copy, preview) are 28px instead of
  spilling past it, and icon actions keep a 36px tap area. The Preview
  tab's address bar, device menu and `⋯` menu are 28px too (v3.40.0).
- **Home-screen widgets on iPhone and Android** `[v3.31.0]` — three widgets
  for the mobile app: **Quick start** (start a new session, or continue the
  last one), **Sessions** (up to three sessions, the ones that need you first,
  then the ones still running) and **Next task** (the next scheduled task,
  with a countdown on iOS, and whether its last run passed). Tapping one opens
  that session, a new session in your last folder, or the scheduler on that
  task. The widgets show what the app last synced, with an "as of" time;
  after 30 minutes the "Needs you" and "Running" labels turn into plain ages.
  They never hold the server address or access key. The `openagentd://new`
  and `openagentd://scheduler?task=<id>` links they use work from anywhere,
  and links into the Android app now also work on older Android System
  WebView versions.
  A widget's session opens on the server the widget synced from
  `[v3.52.0]`, switching to it first when the app is on another one, and a
  link is handled once even when iOS reloads the app in the background.
  Since `[v3.55.0]` a widget never opens a session on the wrong server: a
  row whose server the app no longer knows opens nothing, says so, and shows
  Servers. Removing the server the widgets show, or signing out of the
  account whose computer they show, empties them. A Chat session is named
  "Chat" (it used to show your login name), and a snapshot the phone could
  not save is sent again with the next change. A snapshot read from one
  server is not saved once the app has moved to another (it would have
  filed the first server's sessions under the second).
  A session at work reads **Running**, the word the sidebar uses (it read
  "Working"). On Android each label has its own text colour, as on iPhone;
  a widget placed before the app has synced says to open OpenAgentd instead
  of "Nothing needs you right now"; and a snapshot whose time cannot be
  read counts as not synced instead of showing "as of 20000d ago".
- **Phones: everything fits, nothing twice** `[v3.41.0]`:
  - Typing in the composer keeps the caret at the end of the text; it used
    to drift further from it with every letter.
  - Send is 36px like the controls beside it, so the row keeps its height
    when Send splits into Steer and the queue menu mid-turn.
  - Bottom sheets close with a pull down anywhere on them, not only from
    the handle (the run picker's accounts included), once their content is
    scrolled to the top; until then the pull scrolls back up.
  - Every thinking level fits the run picker: Extra high reads **XHigh**
    (on the run chip too), and the sheet puts the Thinking label above the
    levels.
  - The footer under a message (Copy, Edit prompt, Undo *(removed in
    v3.42.0)*, the files pill and
    the details line) and a prompt's Edit and Copy are drawn smaller and
    closer together, with the same 36px touch targets.
  - A question card's caption ("Answer at least one question to send.")
    stays on one line, with its buttons under it.
  - A segmented control that wraps onto two lines (the Providers status
    filter) fills only the chosen segment.
  - The run chip under the composer opens Model and thinking.
- **Faster sessions, one panel on phones** `[v3.45.0]`:
  - A running session, or one with a long history, opens in about half the
    time, and over a slow link (a phone on the LAN) several times faster:
    the history and the live answer load together, and the first page of a
    lead's history carries only the latest few rows of each subagent.
  - The phone header has no More (⋯) sheet: it shows the sidebar, the title,
    the Task list and the Review panel. Terminal, find file and scheduled
    tasks open from the Review panel, the command palette from the drawer
    footer, and a swipe from the right edge opens the Review panel.
  - A shell call's tooltip shows only its description (the command is
    already on the row), and other tooltips (copy buttons, a prompt's and an
    answer's actions, session rows) are the system's plain tooltips, so a
    long transcript renders lighter. *(Since v3.46.0 the row shows the
    description and the tooltip the command.)*
- **Mobile keyboard viewport guardrails** `[v1.99.1]` — virtual-keyboard detection now uses the pre-keyboard layout height, the mobile shell stays pinned instead of following `visualViewport.offsetTop`, and chat auto-stick ignores keyboard-only scrollport resizes so manual transcript scrolling no longer flickers on iOS/WebViews.
- **iOS text size** `[v3.0.0]` — the iOS app follows the system text size
  (Settings or Control Center) while it runs: larger settings scale the text
  and spacing together, up to 125%. Smaller settings keep the design size.
- **Typing on a phone** `[v3.22.0]` — every text field works with the
  keyboard up:
  - Plan review on a phone: selecting plan text offers **Comment on selection**
    in the footer, the comment box docks on the keyboard, saved comments fold
    into a chip while you type, and a half-written comment survives closing
    the sheet. Reply in chat and Approve stay in reach.
  - The plan review footer is one row of actions under your comments. On a
    phone Keep going is a toggle in the row and its turns show above it, so
    **Reply in chat** and **Approve** always fit the screen, even on an
    iPhone mini. The comment box docks in the chat composer's shape and takes
    its swipe (up for the keyboard, down to put it away); the header and tabs
    stay put while the keyboard rises. `[v3.49.0, updated v3.59.0]`
  - **Reply in chat** closes the plan sheet and focuses the chat box, with
    your comments already in it as a chip, the way Preview comments arrive.
    There is no feedback box in the sheet: you type the rest in the chat box
    and send it as a normal message. `[v3.59.0]`
  - The chat re-pins to the newest message when the keyboard opens, Send and
    Steer keep the keyboard up, and tapping the transcript puts it away.
    Since `[v3.49.0]` scrolling the transcript keeps the keyboard up, so you
    can read while you type; a swipe down on the composer still puts it away.
  - Menus, the model list, the palette and dialogs open in the space above
    the keyboard; sheets no longer raise it on open.
  - Fields for ids, paths, URLs and keys skip autocorrect and
    auto-capitalise, keyboards show Search / Next / Done, scheduler Return
    moves to the next field, and the scheduler time uses the iOS picker.
  - Denser touch layout: 36px list rows and tighter line height.
- **Mobile / phone-first layout** `[since v1.0]` — breakpoints, safe areas, drawer
  shapes, composer keyboard avoidance, touch row actions, pull-to-refresh,
  haptics, and legibility guards optimized for small screens `[v1.45.2]`;
  long-press rows get native impact haptics (`tauri-plugin-haptics`) and an
  iOS-style press-and-hold scale animation `[v1.47.0]`.
  The chat actions menu also opens Search files (Quick Open) and the command
  palette `[v3.0.0]`.
  Sending a message and an agent asking you a question each give a light tap
  in the phone apps `[v3.25.0]`.
- **The phone app reads like an iOS app** `[v3.48.0]`. It is still the web
  UI; the changes apply only on a phone (touch and narrow). Tablets and
  narrow mouse windows keep their layout.
  - `[v3.49.0]` The composer's **+** menu has **Photos** and **Files**, which open the phone's photo library or document picker directly in the iOS and Android apps. Send and Stop are a little smaller, and the context ring sits with the run controls instead of beside Send. Above the composer, the running line and side questions share one slim line (side questions is a small **btw** pill, no longer floating over the chat, and opening it no longer moves the chat), and the end of the chat stays in view as it changes, even with the keyboard up; as the keyboard opens, the chat rises smoothly with the composer. Queued and steer messages wait, faded, at the end of the chat instead of above the composer; tap one to take it back into the composer. Rows under Pinned on the Sessions screen no longer show a pin mark.
  - The app opens on **Sessions**, which has a large title, a search field,
    and *Needs you* at the top, then Pinned and the workspaces. Pull down to
    refresh. Swipe a row left to Pin or Delete it; Delete asks first. A long
    press still opens the row's menu.
  - A tapped chat slides in from the right. ‹ Sessions, or a swipe from the
    left edge that follows your finger, goes back to Sessions. Android Back
    goes up one level, and from Sessions it leaves the app. Links,
    notifications and widgets open the chat with Sessions underneath.
  - Text and touch targets use Apple's sizes: 17px text, 44px rows and
    buttons (48px on Android) and a 51×31 switch. The composer is a step
    smaller so it stays compact: 15px text and 36px buttons that still
    take a 44px touch. Text size
    Compact and Large go one step down or up from there, and Dynamic Type
    applies on top.
  - Settings, Scheduled tasks and Usage open from a toolbar at the bottom of
    Sessions. They are full-width sheets with a grabber and a Done button. A
    Settings section slides in over the list, and ‹ or a swipe goes back.
  - Review opens as its own page with ‹ Chat. Tasks, the "+" menu and the
    model picker are sheets that open at half height and pull up to almost
    full height.
  - On iPhone, confirmations are iOS alerts: Cancel sits beside the action,
    and a destructive action is red and is never the default button.
- **A tighter phone app, with Servers under Sessions** `[v3.49.0]`:
  - Text and rows are the composer's size: 15px text and 40px rows and
    buttons at Default (44px header; bar buttons keep a 44px touch). Text
    size Compact goes down to 14px and 36px; Large is Apple's 17px and
    44px. The composer itself is unchanged.
  - **Servers** is a level under Sessions: ‹ Servers (or a swipe from the
    left edge) shows the saved servers. **Sessions ›** on the one in use
    goes back to its list; **Use** on another switches to it and opens its
    Sessions. Sessions names the server under its title, and Android Back
    goes Chat → Sessions → Servers, then leaves the app.
  - Swipe up on the composer to raise the keyboard, down to put it away.
  - The toolbar at the bottom of Sessions has Settings, Scheduled, Usage and
    the theme (System → Light → Dark) instead of Commands; its icons and
    captions sit centred at any text size, and it steps aside while you
    search.
  - Hold **✎** on Sessions to pick where the new session starts: Chat, the
    recently active workspaces and the current one open above it, and ✎
    turns into ✕. Slide to one and lift to start there; lift on ✕ or
    outside to cancel. ✎ presses in under the finger and springs back as the
    menu blooms out of it. A finger on the toolbar's icons slides across them
    too, with a bubble naming the one under it; lifting runs that one.
  - A changed file's and a commit's actions in the Review panel (long press
    or ⋯) open as the same bottom action sheet as every other phone menu,
    destructive action last; so does the Review panel's **+**.
  - In Settings, the filter of Providers, Agents, Skills and MCP servers
    stays pinned at the top while the list scrolls.
- **Phone chat bar, lighter shell rows** `[v3.49.0]`:
  - The phone chat bar's title and workspace sit on the left, with **Tasks**
    (open-task badge) and **Review panel** as one-tap buttons instead of ⋯.
  - Tapping the title shows the session's info with the current git branch.
  - A described shell call streams only its description; the command loads
    from history when the row is opened.
  - Opening a shell row whose output isn't saved yet retries quietly, and
    its loading or error state shows inside the terminal block.
- **Remote-backend mobile shell** `[v1.34.0, v1.106.0]` — Tauri mobile app scaffold embeds
  the shared Web UI and connects to saved remote API servers. Foreground resume
  now reconciles missed history and replaces potentially frozen chat streams;
  remembered-server launches prefetch and reuse native credentials.
- **Mobile app that feels native** `[v3.31.0]`:
  - On Android, Back closes the open sheet, dialog or drawer first, then goes
    back a page. On the first page it sends the app to the background instead
    of quitting.
  - On iOS, when the system ends the app's web content in the background, the
    app reloads instead of showing a blank screen. Your draft and the screen
    you were on are kept.
  - The launch screen, status bar and navigation bar follow the theme picked
    in the app (or the system theme when it is set to System). On Android,
    the launch screen uses the paper colours instead of white or grey.
  - Buttons are at least 48 dp tall on Android (44 pt on iOS).
  - Long-pressing app buttons and icons no longer opens the iOS link and
    image menu. Message text, images, code and input fields keep it.
  - Switches and segmented controls tick with a light haptic, and git
    actions end with a success or error haptic.
  - List rows darken while your finger is on them.
  - On an Android phone turned sideways, the drawers and the review dock
    stay usable and keep clear of the camera cutout.
- **iOS launch screen** `[v3.25.0]` — follows the system appearance: dark
  paper in dark mode.
- **iOS app on TestFlight** `[v3.49.0]` — releases are built, signed and
  uploaded to TestFlight by CI. Install from the public TestFlight link in the
  release notes: no computer, VPN or 7-day refresh, automatic updates, and the
  home-screen widgets share data through the real App Group. See
  [Install the iOS app](../../../mobile/INSTALL-IOS.md).
- **iOS channels: TestFlight beta and App Store** `[v3.49.0]` — the iOS app
  ships only through App Store Connect; the SideStore IPA and source feed are
  no longer published. One build goes to TestFlight and then, unchanged, to
  the App Store. The iOS app no longer checks for updates itself:
  TestFlight and the App Store deliver and announce new versions.
  Maintainers can send any branch to TestFlight Internal from CI, for example
  from the phone through the agent.
  Before anything is sent, the iOS app asks once for consent to share what you
  write with the AI providers your server uses, with a link to the privacy
  policy, which is also in **Settings → About OpenAgentd** `[v3.49.0]`.
- **iOS app on the App Store** `[v3.55.0]` — OpenAgentd is free on the
  [App Store](https://apps.apple.com/app/openagentd/id6831600179) for iPhone
  and iPad (iOS/iPadOS 15.0 or later). The public TestFlight beta stays for
  early builds; a device has one or the other. See
  [Install the iOS app](../../../mobile/INSTALL-IOS.md).
- **Android app (APK)** `[v3.15.0]` — releases include a sideloadable
  `OpenAgentd_<version>_Android.apk` with a checksum. Access keys are
  encrypted with an Android Keystore key, downloads open the system share
  sheet, and `http://` LAN servers are allowed (the server has no built-in
  TLS). See [Install the Android app](../../../mobile/INSTALL-ANDROID.md).
