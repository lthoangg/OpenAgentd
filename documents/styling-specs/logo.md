---
title: Logo Specifications
description: Source-faithful octobot mascot, lockups, sizing rules, clear space, and asset delivery formats
status: stable
updated: 2026-05-07
---

# Logo Specifications

## Primary logo

- **Format**: Original octobot mascot + `OpenAgentd` wordmark
- **Mascot source**: `documents/assets/brand/octobot-agentd-source.png`
- **Canonical assets**: `documents/assets/brand/`
- **App assets**: `web/src/assets/brand/`
- **Wordmark casing**: `OpenAgentd`
- **Wordmark font**: Inter/system sans, 800 weight
- **Positioning**: mascot left, wordmark and agent-runtime copy right

The octobot is the brand. Do not redraw it into a generic robot, simplify the tentacles, replace the eyes, or change the proportions. New assets must embed or directly derive from the source PNG.

---

## Logo variants

| Variant | File | Use |
|---------|------|-----|
| **Primary lockup** | `openagentd-primary-lockup.png` | README, docs, landing pages, wide marketing surfaces |
| **Stacked badge** | `openagentd-stacked-badge.png` | Square cards, social avatars, release graphics |
| **App icon** | `openagentd-app-icon.png` | Transparent mascot icon for sidebar logo, app chrome, and tight UI logo spots |
| **Social header** | `openagentd-social-header.png` | OpenGraph images, social banners, project headers |
| **Source mascot** | `octobot-agentd-source.png` | Empty states, illustrations, source derivation |

Use PNG exports as the canonical delivery format because the mascot source is raster and SVG image references can render inconsistently across browsers, README renderers, and export tools.

---

## Brand copy inside lockups

Prefer agent-centered language:

- `On-machine agent orchestration runtime`
- `Tools + memory + teams + observability`
- `LOCAL AGENT RUNTIME`
- `Build, run, and observe local AI agents.`

Do not lead brand assets with implementation technologies such as FastAPI or React. Those belong in technical docs, not identity lockups.

When text appears inside a filled pill, badge, or bordered container, center it both visually and structurally (`text-anchor="middle"`, `dominant-baseline="middle"` in SVG; flex center in UI code).

---

## Palette

| Name | Hex | Usage |
|------|-----|-------|
| Agent Gold | `#FCC352` | Primary brand surface, badges, brand emphasis |
| Loop Orange | `#FA8030` | Energy accent, selected brand details |
| Kernel Brown | `#5F2511` | Mascot linework, text on gold, warm dark contrast |
| Shell White | `#FBF8F7` | Light brand surfaces and mascot highlights |
| Console Ink | `#17120F` | Dark brand surfaces |

The product UI can remain neutral and restrained; the brand assets carry the warm octobot palette.

---

## Clear Space & Sizing

### Clear Space

Maintain clear space equal to the octobot eye diameter around the mascot or full lockup. Nothing should intersect the tentacles, antenna, or wordmark area.

### Minimum Size

- **Primary lockup**: 320px wide minimum in digital contexts
- **Stacked badge**: 96px square minimum
- **App icon**: 16px minimum, though 32px+ is preferred
- **Source mascot in empty states**: 48px minimum

At very small sizes, use `openagentd-app-icon.png` instead of the full lockup.

---

## Logo No-Nos

Do not:

- Redraw the mascot from memory
- Use the old stickman assets
- Use the old `o.` monogram direction
- Mention implementation technologies in logo lockups
- Distort, crop, mirror, or recolor the mascot paths
- Put non-centered text inside filled pills or badges
- Add unrelated decorative patterns behind the mascot
- Replace the warm palette with generic blue/purple SaaS colors
- Use the mascot as a repeated background texture

---

## Asset Delivery

| Format | Use Case | Specs |
|--------|----------|-------|
| **PNG** | Web, docs previews, app UI, slide decks | Canonical exported format for source-faithful mascot assets |
| **ICO / ICNS** | Favicon, app launchers | Use a platform-specific background if required by the target icon format |

Use Pencil for brand-board composition and visual review. Final checked-in exports live in `documents/assets/brand/`; app-imported assets live in `web/src/assets/brand/`; direct browser URL assets such as the favicon live in `web/public/brand-assets/`.
