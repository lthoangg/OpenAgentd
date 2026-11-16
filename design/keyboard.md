# Design: keyboard focus

Part of the design system. [`DESIGN.md`](../DESIGN.md) holds the tokens and the map of chapters.

## Keyboard focus model

Tab follows the DOM order: every control is its own Tab stop. Composite
widgets (tablists, menus, listboxes, comboboxes) keep their own arrow keys.

- **Row actions** are never hover-only. Transcript and Review panel rows
  show theirs at rest (dimmed until the row is hovered or holds focus).
  Dense list rows (sidebar sessions and folders, commit history) swap their
  icon actions in for the row's meta on hover or keyboard focus, and every
  one of those is also in the row's right-click / long-press menu, which
  touch shows at all times. All keep a keyboard shortcut: F2, Delete,
  Shift+F10 / the Menu key (`lib/focus/item-keys.ts`).
- **Quiet focus**: focus a script hands back without a key press (the
  composer pill on page load) goes through `focusQuietly`
  (`lib/focus/quiet.ts`), so it draws no ring until the keyboard moves on.
  Focus fills use the `focus-key:` variant (keyboard focus that was not
  handed over quietly), not `focus-visible:`, so quiet focus draws no fill,
  and a tooltip does not open on it either.
- **Ring follows input** (desktop): focus rings show only after a key press
  and hide again on the next pointer press. Focus a script gives — the
  composer at launch, a fold after its Collapse click — draws none until the
  keyboard is used. Text fields keep their focus styles.
- Focus never rests on `<body>` or in an `inert` panel; it returns to the
  composer.

Tooltips follow native timing: 500 ms on hover, then instant for 300 ms after
one closes; a press, key or scroll closes them, and focus opens them only when
it came from the keyboard. A tooltip is a raised `bg-tooltip` chip with a
`tooltip-border` hairline (its arrow carries the hairline on its outer sides).
