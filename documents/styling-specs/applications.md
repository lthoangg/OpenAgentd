# OpenAgentd styling applications

_Last updated: 2026-07-02_

OpenAgentd uses a custom warm-paper design language built with plain Tailwind CSS tokens. Do not introduce shadcn styling defaults for app primitives.

## Surface language

- **Cards and panels:** `bg-(--bg-card)`, `border border-(--color-border)`, subtle hover via `bg-(--bg-key)/30` only.
- **Inputs:** `bg-(--bg-input)`, `rounded-sm`, `text-xs`, fixed border at rest and hover; focus uses `ring-(--focus-ring)/30` without changing border width.
- **Buttons:** use `Button` from `web/src/components/ui/button.tsx`. Variants are `default`, `subtle`, `danger`, `danger-subtle`, `ghost`, `link`, and `primary`.
- **List rows:** use icon wells (`h-8 w-8 rounded-xs border bg-(--bg-key)`) on the left and separate `trailing` content on the right.

## Radius system

- `rounded-xs` / 6px: icon wells, badges, segmented-control segments.
- `rounded-sm` / 8px: cards, inputs, buttons, list cards.
- `rounded-md` / 10px: modal and overlay shells.
- Larger radii are reserved for promotional or decorative layouts.

## Settings components

Use these shared settings primitives instead of hand-rolled repeated markup:

- `SettingsSection`: section wrapper with heading, description, and `SectionCard` surface.
- `SettingsField`: label, control, hint, and error layout.
- `SectionCard`, `SectionCardHeader`, `SectionCardRows`, `SectionCardRow`, `SectionCardBadge`: dense card/list family. Also used by the `/telemetry` page (`web/src/routes/telemetry/primitives.tsx` re-exports them) for its usage, provider:model, cache, and traces sections — see [`observability.md`](../docs/observability.md).
- `SearchBar`: icon-prefixed search/filter input with clear button, optional count, and `onSearch` callback.
- `SegmentedControl`: compact warm-paper segmented toggles.

## Mobile settings layout

`SettingsModal` is mobile-first:

- Desktop: left sidebar + content with breadcrumb rail.
- Mobile: sidebar hidden, bottom tab bar for primary sections, content fills the modal.
- Drill-down screens expose a mobile back arrow in the modal title bar.
- Content wrappers use `p-3 sm:p-5`; touch targets use `min-h-11 md:min-h-0` where appropriate.

## Floating and positioned UI

Use `@base-ui/react` only for behavior-heavy primitives where positioning, focus, or modality matters:

- Dropdown/menu positioning.
- Popover positioning.
- Dialog/sheet focus and modality.
- Tooltip positioning.

For non-positioning controls, prefer semantic HTML with Tailwind tokens and `cva` where variants are needed.
