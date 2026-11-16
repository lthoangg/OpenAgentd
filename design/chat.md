# Design: transcript and composer

Part of the design system. [`DESIGN.md`](../DESIGN.md) holds the tokens and the map of chapters.

## Transcript rows

**Transcript rows** (`ui/meta-row.tsx`): tool calls, reader steps and file
operations share one row: the content on the left and a right-aligned 96px
meta column of tabular mono numbers (`33 ms`, `2.4 s`, `exit 1`), so values
line up down the transcript. 28px, 36px on touch. No icon gutter: the real
tool name in mono leads (`shell`, `grep`, `team_spawn`), then the target in
mono, then a short result summary in muted sans. A running row has a 6px
dot before the name and a live timer in the meta column; text never
blinks. A failed row shows its summary in error colour and an `exit 1` or
`error` chip. Rows without details render as a `div`, not a button.
A subagent row is a button to its session, with its state in words
(Running, Done, Failed, Needs you, Stopped) and a live clock. A team or
workspace call carries its "open it" control in its own row, never on a
row under it: a small chip after the target (the subagent's state, or
**Open**) with ↗. The row is a button, so the chip is drawn in it and a
visually hidden button beside the row serves keyboard and screen readers,
its focus ringing the chip. A tool section
header (arguments, command, output) is a `button` with `aria-expanded`; its
Copy is a sibling, always visible, and says "Copied" for a moment.
A tool row has no tooltip: what its title cuts short (a long URL, query or
pattern) is the first line of the open row. Its menu (right-click, long
press) only opens files: **Open** `path` for each file a `patch` left in
place (no deleted file; a moved one at its new path) and the file a `read`
read, at the line it started from (`ToolCall/fileTargets.ts`), into the
Review panel. Other tool rows open no app menu; Copy is the open row's.

## Turn footer

**Turn footer** (`AssistantTurnFooter.tsx`): under the last finished answer
the actions show at rest as muted 24px icon buttons (13px lucide icons, the
same size as the prompt's Edit and Copy): Copy · Edit prompt,
then the files pill (`FileDiff`, count, `+a -d`). Their words are the
names and tooltips. On a phone the footer and the prompt's actions are drawn
28px and close together, so the row fits an iPhone mini; `touch-hit` keeps
each a 36px target. Older answers keep Copy and the meta line. An
action that cannot run now stays visible, dimmed (`aria-disabled`, so it
keeps focus), and its tooltip says when it can. The meta line names the
model and the account the turn ran on. The files pill opens the
files the turn edited (in Simple and in Full), each opening its diff.

## Cards in the transcript

**Cards in the transcript** (a question, a plan review, a goal claim, a
waiting or stopped turn, the undo notice): one `border-subtle` frame, no
icon before the title, nothing framed inside. The decision sits on the card:
a question has only **Back** and **Next**, with **Send** in Next's place on
the last (or only) question (unanswered questions go out as skipped, the
caption says how many) and keys 1–9 for its options; a plan review has **Approve** (or **Approve
and keep going (N turns)** while a goal would start), **Request changes**,
which opens a focused comment box at once, and **Open plan**. A waiting or
stopped turn says why and since when, lists its ways forward and has
**Copy details**. Content text in cards is at least 12px (`text-xs`);
`text-meta` is for chips and meta lines.

## Touch menus

**Touch menus.** A long press on a link or a `patch` / `read` row (Open the
file) opens the same items as right-click, as a bottom sheet with a
light haptic, the app's own sheet in the iOS and Android apps alike, and so
is a session row's menu. Messages (yours and the agent's), code blocks and
other tool rows have no app menu, on desktop or touch: they keep the system
menu and native text selection, and their Copy / Edit buttons.

## Composer and run deck

**Composer and run deck** (`components/composer/`): the composer is docked at
the foot of the chat column on every screen, in the column's flow (never
floating over the transcript), up to the 768px prose measure, always open:
no drag, no collapse, no saved position. It is one framed field (one
`border-subtle` hairline, no shadow); nothing inside it has a border. The
message box grows to six lines, then scrolls inside. Its own scrollbar stays
hidden (it would narrow the text under the highlight mirror), so from a
pointer a 3px thumb just past the text's right edge shows the scroll; a
phone keeps the system's indicator. Under the text sits the run deck, which
says how the next message runs:

```
[+•] [Code] [model · Level · Account ▾]   (ring 42%) [Send]
```

Every control in the deck is one height, the same steps as Send: 28px on
desktop, 32px in a narrow mouse window, 36px on touch. A phone keeps the
composer compact: its controls stay 36px (the deck's "+" skips the phone's
Button floor) and `touch-hit` grows their touch area to 44px; the message
is 15px and the deck's labels 13px, the phone scale's Default steps. All
are rounded `radius-sm` (6px) but Send, a full
circle. The context ring stays 36px wide
on a phone so a 320px screen leaves the chip its room. With a mouse, the
stacked chip (below) is 36px: its two lines need it.

- **"+"** opens the add menu: Attach, Mention a file, Snippet, Side question
  and, once the agent has one, Connectors (state in words, Sign in,
  on/off). The deck has no connector button: while one needs the user, "+"
  carries a 6px dot in the orange text tone (its description names the
  connector) and opens at that section.
- **Code/Plan** is one toggle button naming the mode in force; a tap (or Tab
  in the message field) switches to the other. Code, the default, sits on the
  keycap wash; Plan takes the selection fill, so it shows at a glance. Both
  words hold the slot, so a switch moves nothing beside it. A switch queued
  behind a running turn is italic until it applies. Plan mode changes the
  placeholder to say the agent reads and proposes without editing.
- **The run chip** names the model in sans (`claude-sonnet-4-6`), a label
  rather than an ID to copy, then the thinking level and a pinned account in
  words. The `provider:model` ID is in mono in its tooltip
  (`anthropic:claude-sonnet-4-6 · Change (⌘.)`, hidden while the picker is
  open), in its accessible name with the shortcut, and in the picker. A long
  model name gives up its start (`…sonnet-4-6`), since models differ at the
  end, everywhere a model is named; a phone shows that end alone. Under 520px
  of composer width (container query) the chip stacks into two lines and the
  context ring drops its percentage.
- **The run picker** (⌘., `/model`, `/think`, the palette's "Model and
  Thinking…") is one surface for all three: a model search with Recent first,
  thinking as a segmented control (←/→ step it from the empty search; Extra
  high reads XHigh there and on the chip, and the phone sheet puts the
  Thinking label above it so every level fits), the
  provider's accounts with state and quota left ("Auto" first), then Reset to
  default and Make default. A popover on desktop and tablet, a bottom sheet
  on phones. Every pick saves on the session at once; a refused save puts the
  previous choice back and says so. The search is borderless over a hairline
  like the other pickers, matches with fuzzysort and ranks in one list; the
  list keeps its height while a search narrows it, so the field never moves
  under the typing. A popover placed above its trigger is held by its bottom
  edge (`ui/popover`), so a change of height never leaves it hanging.
- **The context ring** opens the numbers and "Summarize now".
- **Send** is a keycap fill until there is something to send, then Bark. It is
  36px on touch like the controls beside it, so splitting into Steer and the
  delivery chevron mid-turn changes no height.
- **The tray** above the text holds what waits on the composer: the side
  question, the Undo notice and the "↓ N new" chip. Queued messages (each
  with Remove) wait at the bottom of the transcript, under the running turn,
  faded. The transcript never shows the tray's items a second time.

## Bottom sheets

Bottom sheets (`ui/bottom-sheet.tsx`) are the phone form of any picker or
menu: a grab handle, drag or Esc to dismiss, safe-area padding, 44px rows.
As on iOS, a pull down anywhere on the content drags the sheet once nothing
under the finger is scrolled down; until then the pull scrolls back up.

## New-session hero

**New-session hero** (the draft screen): a `text-lg` semibold question with
the folder in mono, a 24px `rounded-full` folder chip opening a filterable
listbox (the only `shadow-depth` here), then, on desktop, the full composer
inline at ≤ 640px, sitting a little above the
optical middle. Recent folders are 24px `rounded-full` chips; recent sessions
reuse the list rows. A one-line `meta` hint row lists `/`, `@`, ⌘K and ⌘N on
desktop only. Phones keep the composer docked at the bottom and never
collapse it. No starter prompts: the composer is the call to action. The
first message hands off to the chat in one motion: the composer box glides
to its docked slot (`slow`, a translate and a width tween, never a scale),
the hero fades out (`fast`) and the transcript fades in (`base`).

## Agent chips

**Agent chips** are `full`-radius pills using the identity triplet — soft
background, tuned text tone, solid dot.
