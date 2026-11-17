# Design: phones and tablets

Part of the design system. [`DESIGN.md`](../DESIGN.md) holds the tokens and the map of chapters.

## Mobile shell

The Tauri webview sets `data-mobile-shell` on `<html>`, which switches the
document to `position: fixed` and disables text selection outside content
regions. Reference viewport is 390×844.

A phone turned sideways (Android; iPhone is portrait-only) is wider than `md`
but still mobile: `useIsMobile` also matches a height under 580px. Gate
mobile-only surfaces on `useIsMobile`, not on `md:` classes, which would apply
desktop layout to them. Drawers fixed to a screen edge sit outside the shell's
side padding, so they add `pl-safe` / `pr-safe` to clear a camera cutout.

Keyboard handling is the subtle part: `--app-vh` and `--app-vt` track the visual
viewport, and overlays follow the keyboard by **translating** rather than
resizing. While the keyboard is up, `.pb-safe` drops from the home-indicator
inset to a flat 8px, because the indicator is hidden behind the keyboard and the
inset would only waste a strip of space.

The shell blocks pinch zoom, so the iOS app follows **Dynamic Type** instead
(`lib/dynamic-type.ts`). A hidden probe set in `font: -apple-system-body` reads
the user's text size, and the root font size scales from 16px by that size over
iOS's default of 17px. The scale never goes below 1, because the type scale
assumes the design size, and stops at 1.25. Everything in rem scales with it:
text, spacing, and touch targets. Px sizes do not. The app's own Text size
setting multiplies on top (type only).
Android scales text in the shell instead: `ShellPlugin` sets the WebView's
`textZoom` from the system font scale, between 100% and 125%.

The phone apps keep the app's own controls: a choice of a few values (theme,
text size) is the same segmented control as on desktop, and a long press
opens the item's menu as the app's bottom sheet on iOS and Android alike.
Haptics mark a send, an arriving question, a mode change and a sheet
dismissed by drag.

### A phone is a navigation stack

**A phone is a navigation stack** (`useIsPhone`: `useIsMobile` on a
touch-first device; a narrow mouse window and a tablet keep the drawer
layout). Three levels, all mounted: `components/phone/PhoneStack` holds
Sessions with a chat pushed over it, and that stack is the page of a second
`PhoneStack` over Computers. Only one of the two takes the edge swipe and
Back at a time.

- **Computers** (`/servers`, `components/phone/ServersScreen`, loaded lazily)
  is the bottom level: a large **Computers** title over one list, the
  account's computers and those added by address together, the same list as
  Settings → Server (`AppBackendPanel`). The row in use offers
  **Sessions ›** back up to its list; **Use** on another switches the app to
  it and lands on that computer's Sessions. While a computer answers, a swipe
  left anywhere on Computers pulls Sessions in (the reverse of Back); with
  none connected it gives a little and springs back with an error tick. On
  touch a row keeps one button (Use, or Sessions ›); Edit and
  Remove are in its action sheet, from ⋯ or a long press. **Add a computer
  by address** asks for Address, Access key and Name, and **Connect** tests,
  saves and opens it. A row is a name
  and one status line, on every platform: a computer's own name (its host
  name until it is renamed), never its key or address. Those are under
  **Details** (a computer's sheet on touch, a button with a pointer), where
  the computer in use is renamed. A key shows on a row only for a device
  the app has never been on, and after a name while two share it; it always
  shows in full where a device is approved or removed.
- **Sessions** (`/sessions`, the sidebar's `page` mode) is the first screen
  the app opens on: ‹ Computers in the bar, a 28px
  **Sessions** title (`text-large-title`) that hands over to the bar's small
  title as it scrolls away, the computer's dot and name under it (a tap goes
  to Computers too), a search field, then Needs you, Running, Pinned and the
  workspaces (Running is the phone page's own section; the desktop sidebar
  keeps only Needs you). Pull down to refresh. Swipe a row left for Pin and Delete
  (Pin is neutral, only Delete is red; Delete confirms); a long press
  opens its menu, so rows have no ⋯ here. The toolbar floats over the end
  of the list, as iOS 26's does, on a fade of the page: a pill of icon
  buttons on the left (Settings, Scheduled, Usage, and the theme, showing
  the current choice; a tap moves System → Light → Dark) and the round
  primary ✎ New session on the right, under the thumb. They are actions,
  not tabs, so there are no captions; each is named for assistive tech. It
  steps aside while searching, so it never rides up on the soft keyboard.
  ✎ taps a soft haptic and pushes a draft that is already built; held, it
  opens **New session in…**, an action sheet of Chat and the recent
  workspaces (the current one last).
  **Search** happens in place: the field moves under the bar with a
  **Cancel** beside it, and the list gives way to results under the field.
  Before anything is typed it shows **Recently opened** (the latest eight
  sessions), never an empty pane.
  The command palette has no button on a phone; ⌘K opens it from a
  hardware keyboard.
- **A chat or a draft is pushed** over it from the right; Sessions drifts a
  third of the way left under a scrim. The chat's bar is `PhoneNavBar`:
  ‹ Sessions in the accent, the title centred over its workspace, Tasks and
  Review panel on the right (20px glyphs in the accent).
- **Back is by level, not by history**: ‹, a swipe from the left edge (it
  follows the finger and springs on with its speed) and Android Back all go
  to the parent: a chat to Sessions, Sessions to Computers. A link, a
  notification or a widget opens the chat with Sessions under it; Android
  Back on Computers sends the app to the background.
- **The composer takes a vertical swipe**: up on the box raises the soft
  keyboard (focus is given on `touchend`, the gesture iOS needs), down puts
  it away, as dragging the transcript does. A message that can still
  scroll keeps the swipe, and the tray and suggestion menus above the box
  are left alone. The box lets the browser pan it sideways only
  (`touch-action: pan-x pinch-zoom`, the field too while it has nothing to
  scroll): a vertical pan cancels the pointer, and focus without that
  user activation raises no keyboard (measured on Android Chrome).
- **Review** is a page pushed over the chat (‹ Chat, full screen). **Tasks**,
  the "+" menu and the model picker are sheets with two detents (half and
  nearly full height; `BottomSheet` `detents`). Settings, Scheduled tasks and
  Usage are sheets: the full width, 12px top corners, a grabber, the bar's
  ‹ parent on the left, the title centred and **Done** on the right; a
  Settings section is pushed over the list and swipes back. Android puts a
  bare ← and a left-aligned title in the same bars.
- **Menus are action sheets** (`ui/action-sheet`): a long press (one
  medium haptic, from the gesture) or ⋯ opens the item's title, 44px rows
  with a 16px icon, a destructive row last in red, and **Cancel** in its own
  group under them. No floating menus on a phone. In the iOS app a session
  and a workspace use the system action sheet instead.
- **Confirms are alerts** on an iOS-style phone: a centred 270px card, Cancel
  and the action full width under a hairline, a destructive action in red
  and never the default. Android keeps Material's text buttons.

## Phone system

The rules every phone screen follows. The approved before/after mockups live
in `.agents/plans/phone-ux-sweep-one-design-system-end-to-end-a0dfe956/mockups/`.

- **Status in one second.** One vocabulary everywhere, the session row's
  marks: running is the small spinner (Signal Blue stays the logo and focus
  ring, lint `stray-blue`), needs-you is orange (a question, a plan to
  approve, a sign-in), error is red, done-and-unread is the accent dot,
  idle is hollow. Sessions puts Needs you and Running above the
  workspaces. The connection dot is never green while the server does not
  answer.
- **One thumb.** Rows and controls are 40px (44px in the Android app), and
  bar buttons and Send keep a 44px touch area (Phone scale); the primary
  action of a screen sits in its lower half; nothing depends on hover.
- **Motion.** Screens, sheets and pushes move on `--ease-sheet` or the
  critically damped spring of `lib/drawer-motion.ts`, carrying the finger's
  speed and never crossing their target. The overshooting
  `--ease-spring-*` curves are for small controls only (a switch thumb, a
  radio dot). A pushed screen is built before it slides: content never
  swaps mid-transition. Reduce Motion fades instead (lint
  `overshoot-on-screen`).
- **Type.** Body 17, secondary 15, footnote 13, caption 12, the large
  title 28; all rem so they follow Dynamic Type. Mono is for code, paths and
  commands only, never for model names, durations, costs or labels.
- **Reading.** Wide content (code, diffs, tables) scrolls sideways inside
  its block, with a fade at the clipped edge; it never widens the page.
  Consecutive tool calls collapse into one summary row.
  In Full two or more finished, successful calls in a
  row fold behind "3 commands, 1 read ›" (sans); a failed or running call
  stays open. Tool output is code size and caps at 12 lines, then scrolls.
  Tables scroll sideways as a whole (no pinned column) and shade the right edge only while it is
  clipped. A diff keeps lines whole and scrolls sideways; **Wrap lines** in
  its file bar wraps them.
- **The composer.** It grows to six lines, then scrolls inside. The
  Code/Plan toggle and the model chip are separate controls, so mode is one
  tap; the model chip's sheet picks the model and, under it, the thinking
  level (the label stacked above the levels so six fit an iPhone mini).
  The context ring is a thin gauge, never a spinner; it follows the run
  controls on the left, away from Send, and Send (or Stop) is drawn at
  32pt with a 44pt touch area. A new draft shows only the
  folder chip: no heading, no suggestions.
- **Above the composer, in this order:** the open question (pinned, orange
  frame, 48pt options; the transcript card says "Answer below"), the plan
  awaiting approval ("View" opens it full screen with Approve pinned), one
  28pt status line (the run on the left, "Running · step 7 · 3:12" while the
  agent works; a 24pt **btw** pill with the count on the right, which opens
  side questions in a sheet and stays, pressed, while the sheet is open so
  nothing behind it moves). All of it is in the flow, never floating over
  the transcript, and a reader at the end stays at the end as it grows, with
  the keyboard up too; as the keyboard rises the end rides up with the
  composer every frame. Queued and steer messages wait at the end of the
  transcript instead, as faded user bubbles (four lines at most) with their
  delivery state under them. A tap takes one back into the composer, to
  edit or clear there; there is no ✕.
- **Run control.** Mid-turn, Send is one pill: a tap steers, a long press
  opens an action sheet (Steer now, Send after this turn finishes, Stop and
  send). Stop gives a medium haptic and a "Stopped" toast whose **Resume**
  sends "Continue".
- **Settings.** A switch or a short number sits right of its label at every
  width, with the description running the full row under both (iOS footer);
  other controls stack under the label.
  The root reads like iOS Settings: a large title, one neutral icon tile per
  row (`--bg-key`, `--color-text-2`; per-section hues read as noise), no
  descriptions; each section's page carries its own.
- **The chat bar.** ‹ Sessions, the title, Tasks and Review panel (Mobile
  shell). A tap on the title opens Session info.
- **Long press is the context menu.** A prompt, a session row, a server row
  and a workspace row open an action sheet on a hold, with one medium
  haptic. Destructive items sit last, in red, behind a separator.
- **Sheets over menus.** View options and other choice menus open as
  sheets: a segmented control for one-of-few, a switch for on/off.
- **Folded cards.** A goal check is one 44pt row, "Goal · achieved ›";
  evidence opens as 44pt rows under an "Evidence · N" label, each row one
  wrapped sentence with its code inline.
- **Lists read like iOS.** The Review panel page (Changes, Files, Terminal,
  Preview) and the worktree sheet are grouped 44pt rows with counts; a
  scheduled task has an on/off switch and its schedule as a sentence;
  filters that pin over a list fit in one line (three segments at most),
  and every Settings list (Models, Agents, Skills, Connectors) pins its filter.
- **Thumb reach and full screens.** Jump to latest is a round ↓ at the
  right corner; Preview's address bar sits at the bottom. A memory page
  edits full screen with Save in the bar and a formatting bar above the
  keyboard. Side questions, turn details, Usage filters and the + menu's
  Tools open as sheets; the update notice starts as a one-line banner.
- **Notices.** A banner is one line under the bar with at most one action;
  details open in a sheet. It never covers the transcript.
- **Offline is told, not hidden.** Health is checked whatever the network
  state (React Query `networkMode: 'always'`), again on `offline` and on
  return to the foreground, so the dot turns red and the banner reads
  "Server unreachable · Retrying…" (or "Can't reach {host} · Retrying…")
  within seconds, in sans, truncated to one line. The composer keeps its
  draft. With no server and nothing on screen, the chat shows "Can't reach
  the server" with **Retry**, not a spinner.
- **Feedback.** Haptics come from the gesture (`lib/haptics.ts`): soft for
  a push or a send, medium for a long press or Stop, a tick for an arriving
  question, the error outcome for a refused action. A destructive action
  offers Undo or confirms.
