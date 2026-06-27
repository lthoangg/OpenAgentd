---
title: OpenAgentd Styling
description: Design-system reference for OpenAgentd brand assets, tokens, components, interaction, and motion
status: stable
updated: 2026-05-27
---

# OpenAgentd Styling

Design-system reference for OpenAgentd. Brand assets, tokens, components, interaction, motion.

---

## At a glance

| | |
|---|---|
| **Aesthetic** | Warm paper notebook (cream surfaces, hand-drawn headlines) for chat, with a high-density, flat developer IDE cockpit style for settings |
| **Palette** | Octobot brand pigments on a warm `#FAF6EC` paper background; pastel agent chips for role identity |
| **Type** | Inter (UI/body) + JetBrains Mono (code) + Caveat (handwritten headlines) |
| **Modes** | Light-first paper, dark-equal — both rendered with equal care |
| **Motion** | Motion is information; every animation conveys state, progress, or causality |
| **Token prefix** | `--color-*`, `--accent-*`, `--bg-*`, `--fg-*`, `--font-*`, `--radius-*` |

---

## Pages

| | |
|---|---|
| [Colors](./colors.md) | Paper palette, agent-chip palette, semantic tokens, marker palette for charts, light/dark theme variables |
| [Typography](./typography.md) | Inter, JetBrains Mono, Caveat hand-drawn headlines, type scale, font-weight transitions |
| [Motion](./motion.md) | Motion tokens, spring presets, choreography patterns, reduced-motion fallbacks |
| [Interaction](./interaction.md) | Hover / focus / active model, keyboard shortcuts, state choreography |
| [Layout](./layout.md) | 4px grid, breakpoints, radius scale, depth, accessibility |
| [Logo](./logo.md) | Source-faithful Octobot mascot, lockups, sizing, asset delivery |
| [Imagery](./imagery.md) | Octobot mascot usage, icons (lucide), charts, screenshots, patterns |
| [Applications](./applications.md) | Component guidelines — agent chips, sidebar, input bar, tool call rows, modals, topbar, popovers, empty states |

---

## What changed in this revision

The styling system was previously specified for a cool zinc/Geist neutral aesthetic with reserved Octobot gold accents. The pencil source design has since converged on a **warm paper notebook** language — cream surfaces (`#FAF6EC`), Caveat handwritten screen headlines, Inter UI, and a four-color **agent chip palette** that gives each agent role a recognizable pastel identity (mint for `openagentd`, blue for `executor`, orange for `consultant`, pink for `explorer`).

Codebase migration from previous token names (`--color-jb-*`, zinc neutrals) to the paper tokens is tracked separately.
