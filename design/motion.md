# Design: motion

Part of the design system. [`DESIGN.md`](../DESIGN.md) holds the tokens and the map of chapters.

## Motion

Motion is functional: it explains where something came from, then gets out of
the way.

| Token | Duration | Use |
|---|---|---|
| `instant` | 80ms | Hover, press, color change |
| `fast` | 150ms | Tooltips, chips, small reveals |
| `base` | 240ms | Panels, dropdowns, most transitions |
| `slow` | 400ms | Full-screen overlays, route changes |
| `glacial` | 800ms | Ambient/looping, and the one-time reveal of text the agent wrote (an automated session title) |
| `linger` | 2000ms | Attention washes: a tint that holds, then drains (the sidebar row of a freshly titled session) |

Easings: `ease-out` `cubic-bezier(.16,1,.3,1)` for entrances, `ease-in-out`
`cubic-bezier(.4,0,.2,1)` for state changes, `ease-spring-soft`
`cubic-bezier(.34,1.2,.64,1)` and `ease-spring-snappy`
`cubic-bezier(.22,1.4,.36,1)` for gestural affordances, `ease-sheet`
`cubic-bezier(.32,.72,0,1)` for sheets and anything settling after a drag.
TypeScript reads the same values from `lib/motion.ts` (`DURATIONS_S`,
`EASINGS`); `motion.test.ts` keeps the two in step.

The animation library owns the CSS `transform` property. Never use `transform`
for layout (no `translateX(-50%)` centering) — center fixed elements with
`margin: auto` against `left: 0; right: 0`.

**Rules.** `design-lint.test.ts` enforces the first four.

- **Tokens only.** Write `duration-(--motion-*)` and `ease-(--ease-*)`, never
  `duration-200`, Tailwind's `ease-out`, a literal `cubic-bezier(`, or a bare
  `duration: 0.2`.
- **Name the properties.** Use `transition-colors`, `-opacity` or `-transform`,
  never `transition-all`. Buttons change colour only, at `instant`: the theme
  pins Tailwind's default transition to `instant` / `ease-in-out`, so a bare
  `transition-colors` is already right. A fold, slide or fade names its own
  `duration-(--motion-*)`.
- **Exit timers match their animation.** `useDeferredUnmount(open, DURATIONS_S.fast * 1000)`
  pairs with `duration-(--motion-fast)`. A bare number drifts.
- **Don't animate layout.** Width, height, inset, margin and padding re-lay-out
  every frame. Progress fills slide with `translate` inside a clipping track,
  and folds use `ui/collapsible` (grid rows at `base`, `inert` when closed).
  The exceptions: the pill ↔ card morph of a fixed notice; the command
  palette's and a dialog's height following their content at `fast`
  (`hooks/useHeightGlide`, one clipped box, so the card's edge never jumps
  per key); a switch thumb widening while pressed (a 16px box); and the
  palette's one highlight pill gliding between rows.
- **Everything that opens also closes, and can change its mind.** Popovers,
  menus and suggestion lists grow in at `base` (`fast` for small lists) from
  their anchor (`origin-*`), on the Web Animations API
  (`ui/_use-presence-motion`): reopening one mid-close turns back from where
  it is, never restarting from 0. The context menu fades out at `fast` when
  dismissed by pointer, but closes instantly on Escape or Tab so the next key
  lands where focus went. A chosen row blinks once (~60ms) before the menu
  acts (`ui/_menu-blink`).
- **Things come from where they started.** The lightbox grows out of the
  thumbnail that opened it and shrinks back into it (`lib/lightbox-zoom`);
  desktop overlays settle in at `base` (`ease-out`, from scale .96). On a
  phone a full-screen overlay is a sheet: it rises from the bottom on
  `ease-sheet` and drags down to close.
- **Gestures keep the hand's speed.** A phone drawer follows the finger by
  direct DOM writes (`lib/drawer-motion`, no React state per move) and, on
  release, settles on a critically damped spring seeded with the release
  velocity. It stops hard at both edges: no rubber band, no overshoot. Sheets
  close the same way. A long-pressed row lifts (`scale-[0.98]`) while held.
- **Lists move, not cut.** Reordered rows and dock tabs slide with FLIP
  (`hooks/useFlipReorder`, vertical or horizontal) from where they are drawn;
  a new tab fades in; a dragged tab lifts (scale 1.02 and a shadow) and lands
  on a spring. Session rows fold one by one (`ui/collapsible`). New panes fade
  in; panes never animate their size (terminals and previews would relayout
  each frame).
- **Replacing in place.** An icon that changes with state (Copy → ✓, Send ↔
  Stop, a session's status mark) swaps the SF Symbols way: the old one shrinks
  and fades as the new one springs up (`IconSwap`, `oa-icon-in`). A number
  that changes rolls only its changed digits (`RollingNumber`, tabular
  figures); a badge whose count grows bumps once (`useBadgeBump`). A view
  that replaces another in place crossfades at `fast` (`oa-fade-in-fast`).
  A new message rises in at `base` (`oa-rise-in`).
- **Controls answer the press.** On touch, a pressed button sinks slightly
  (`pointer-coarse:active:scale-*`); on desktop it only darkens. A switch
  thumb stretches toward where it will go and can be dragged; a checkbox
  draws its check; a segmented selection sinks and can be slid; a rejected
  field shakes (`lib/shake`); the focus ring settles in from outside
  (`oa-focus-ring-in`). Snapping a resize onto its default width ticks the
  trackpad on macOS.
- **Live words shimmer, never pulse.** A label the agent is still working on
  ("Thinking…", "running…") carries a light sweep (`oa-shimmer`) over a
  muted base that keeps AA contrast; a dot, mark or skeleton breathes
  (`oa-breathe`); text never fades in and out. A finished task's strike draws
  left to right (`oa-strike`).
- **Whole-window changes crossfade.** Light ↔ dark and a text-size change run
  through the View Transitions API at `base` (`lib/view-transition`); an
  engine without it changes at once.
- **Images appear decoded.** An image fades in at `fast` once decoded
  (`hooks/useImageReveal`) into the box it already reserved, never painting
  in from the top.
- **The transcript holds still.** While you read history, the scroller anchors
  to the first visible block, and images reserve their box before they load.
  Following the stream, it writes at most one scroll per frame. A send or
  Jump to latest within two screens glides to the end (further back it
  jumps; under reduced motion it always jumps), and no instant write cuts a
  glide short, but the reader scrolling against it stops it where they are.
  "Jump to latest" shows only while the view is away from the end and not
  following it, whatever moved it there; a layout that sets the reader down
  on the end takes it away. When a stream ends, the
  text still to show keeps flowing to the end rather than landing in one
  frame. On a phone the header's bottom line shows only once the transcript
  scrolls under it. Earlier turns never move what is on screen: new turns
  at the end never hide one at the top (the hidden count holds while the
  first turn is the same), and on touch earlier turns land in a runway of
  empty room kept above the first turn (three screens, sized only while
  the scroll rests), so a fling is never stopped by a scroll write.
- **Loading placeholders wait a beat.** Skeletons match the geometry of what
  replaces them, and fade in after `fast` (`oa-fade-in-late`), so a fast load
  never flashes one. A saved session shows a transcript skeleton, not the
  empty state, until its history lands.
- **Session switches crossfade.** The transcript being left stays, `inert` and
  dimmed to 70% at `fast`, for up to `fast` while the next one loads (a
  session viewed recently shows its last transcript instead). The next one is
  scrolled into place before paint and fades in over `fast` (`ease-out`).
  Loading states never take the whole pane while a chat is on screen.
- **Automated titles are revealed, manual ones are not.** A `title_update` from
  the agent lifts the old title out over `base` and wipes the new one in left
  to right over `glacial` (`ease-out`, after an `instant` beat). Its sidebar row
  holds a `fill-selected` wash for 40% of `linger`, then drains. Renames you make,
  list loads and session switches swap the text with no motion.
- **A live caret follows streaming text.** A 2px `on-surface-2` bar sits after the
  last paragraph, heading or list item an answer is writing, and blinks at
  `glacial` (`steps(1)`, on or off, never a fade). Code blocks and tables get
  none, and it goes the moment the answer ends. Under reduced motion it stands
  still.
- **Reduced motion snaps.** Every animation drops to ~0ms and transitions are
  off (`0s`, not a tiny duration: an element that declares no transition has
  `transition-property: all`, so any duration turned every change, inherited
  visibility included, into a transition, and a popover's field could not
  take focus as it appeared).
  Progress bars keep moving because time is literal, and spinners keep turning,
  slowly, because a frozen spinner reads as a hang.
