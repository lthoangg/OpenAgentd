# OpenAgentd interaction model

_Last updated: 2026-06-26_

## Rest, hover, focus

OpenAgentd controls should feel calm at rest and precise in motion.

- Rest state uses muted text and a crisp 1px border.
- Hover should gently warm the surface (`bg-(--bg-key)/30` or `/40`) without changing border thickness or causing layout jumps.
- Focus uses `focus-visible:ring-2 focus-visible:ring-(--focus-ring)/30` or `/40`.
- Disabled controls use opacity and `cursor-not-allowed`; do not add extra muted wrappers.

## Buttons

Buttons are plain `<button>` elements styled by `buttonVariants`.

- `default`: paper/card action surface.
- `primary`: strongest positive action.
- `subtle`: low-emphasis toolbar/list action.
- `ghost`: icon or contextual action with transparent rest state.
- `danger` / `danger-subtle`: destructive flows.
- `link`: inline text action.

`LongPressButton` must not inject default button styling. Variant styling is opt-in so it can be used as a navigation row.

## Inputs and textareas

Inputs, textareas, and search fields use warm input surfaces, small type, and stable borders. Avoid hover border jumps. Validation should use `aria-invalid` plus error text, not color alone.

## Selection controls

- `Switch`: pill track, warm rest state, blue checked state, white circular thumb.
- `Tabs`: custom semantic tab buttons for segmented toggles; labels can collapse to icons on narrow screens.
- `SegmentedControl`: use for binary or short enum choices in settings forms.
- `Checkbox`, `RadioGroup`, and `NumberInput`: plain semantic inputs styled with Tailwind tokens.

## Search and filtering

Use `SearchBar` for list filtering. It supports a leading icon, clear button, optional result count, loading state, and submit callback. Filter chips should be stable: clicking an active chip returns to the all/default state, and counts should not disappear mid-filter.

## Settings navigation

- Primary desktop navigation lives in the settings sidebar.
- Mobile primary navigation lives in the bottom tab bar.
- Detail/new/editor screens are drill-downs and expose a back affordance.
- Breadcrumbs are desktop-only; they are hidden on mobile to preserve vertical space.

## Motion

Prefer short color/opacity transitions. Avoid transform-heavy effects in dense settings surfaces. Loading indicators should be small and local; for restart actions, rotate the restart icon while pending.
