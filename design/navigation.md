# Design: sidebar, header, notices and palette

Part of the design system. [`DESIGN.md`](../DESIGN.md) holds the tokens and the map of chapters.

## Sidebar sections

**Sidebar sections.** **New session** (⌘N) sits atop the sidebar, outside the
scroller, so starting is always one click. Below it the session list scrolls
(Pinned, Needs you and the sessions), and its header sticks to the top so its
actions stay in reach. Scheduled sits pinned at the bottom, outside that
scroller, with no rule above it, and scrolls on its own past 224px
(`max-h-56`). Every section uses one header (`Sidebar/SidebarHeading.tsx`): the
name in sentence case, `text-xs` medium muted, a count, and a chevron that is
always visible when the section folds. Needs you counts in a warning chip
with words ("2 waiting"), so colour is never the only signal. Sections are
separated by their headers, not by rules. Scheduled appears with the first
task and stays while any task exists, with a **+** for a new task and an
empty row ("Nothing due") when none is due; with no task there is no heading. The list's header
holds the icon actions (`md:` 24px, 36px on touch): Search and **View
options** (which holds Collapse all and Open workspace…). The workspace tree
shows placeholder rows while it first loads and an error with **Retry** when
it fails; "No workspaces yet" means the tree loaded empty.

## Workspace rows

**Workspace rows** split in two: the chevron folds the list, the name opens
the workspace's latest session (a draft when it has none). The workspace on
screen just unfolds. From the keyboard ←/→ on the name fold, so the chevron
is not a Tab stop. The active workspace's name is medium weight in ink.

## Session menu

**Session menu.** ⋯, right-click and the phone's long-press sheet show one
list in one order: Open in new window (desktop app), Rename (F2), Pin, then a
separator and Delete session… (⌫). A key a row answers to is shown beside
its item, in every menu (`MenuShortcut`).

## Header

**Header.** Desktop: the sidebar button on the left, then workspace · session
title; Tasks and Review panel on the right. The command palette has no
button: ⌘K and the View menu open it. The session title renames in place: double-click it, or press F2
or Enter on it; a single click does nothing, so a stray click keeps the
title. A subagent's title is read-only, like its sidebar row, and its header
leads with ↰ **Open the main agent** (before the title on desktop, first
among the bar's actions on a phone). A narrow mouse window keeps the sidebar toggle,
the title over its workspace, Tasks and Review panel; a phone's bar is
‹ Sessions, the title, Tasks and Review panel (Mobile shell). Every header
control is 36px on touch and the phone's control step on a phone (40px at
Default), with a 44px touch area.

## Notices

**Notices** (toasts, the update notice, the TypeScript tools prompt) stack at
the top right under the header, newest first, so the run deck and Send stay
clear. Phones span the width between the safe-area insets. The update notice
and the tools prompt are one line each (`NoticeLine`): what it is, then at
most two buttons, quiet one first. A line does not move, minimize or expand,
and a failure it runs into goes to a toast.

## Command palette

**Command palette** (⌘K) is one overlay. Empty, it lists commands; typed, it
shows up to three headed groups in order: Commands, Sessions (by title) and
Files, which the arrow keys walk as one list. ⌘P opens it on Files
("Find file…"); Backspace in the empty field, or a click on the Files label,
widens it to every group, and a leading ">" keeps to commands. A page that is
still loading shows a Loading… row, never "Nothing here yet". The field is
16px on phones, so iOS does not zoom on focus.
View options is a context menu of `menuitemradio` groups (Group by, Sort by)
and a `menuitemcheckbox` (Show details); it stays open while choices apply.
Rows in flat views and Pinned name their workspace in mono 11px subtle text,
which gives way first when the row is narrow.

## Sidebar row actions

**Sidebar row actions** share one style (`ROW_ACTION` in `ui/list-row.ts`):
24px, borderless, `rounded-xs`, subtle glyph, keycap wash on hover, the
global focus ring, 36px on touch. They take the place of the row's meta (age,
tags) on hover or keyboard focus and hold no room at rest, so titles and
folder names keep the row; touch shows them always, except Pin, which stays
in More on touch so the title keeps the room; the pin mark itself stays on
touch, except on the phone's Sessions screen, where Pinned and the swipe's
Unpin already say it. Session rows offer **Pin**
and **More**, subagent rows **More**, folder rows **+** and **More**. More
opens the same menu as right-click, so destructive actions are never one
click from a row. Text actions in rows ("Show all") use `ROW_TEXT_ACTION`
(24px), and count chips (subagents, worktrees) one 20px mono pill
(`rowChipClass`) that inks when active. Long titles always truncate: a fold
must never take the width of its longest line.
