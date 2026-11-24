---
title: "Features: The app: Settings"
description: "The Settings dialog: its pages, search, and how changes are saved."
---

# The app: Settings

Part of the [feature catalogue](../features.md), under *1. The desktop coding workspace*. The index explains the version tags.

- **Secrets page** `[v3.59.0]` — Settings → Secrets lists the keys you
  gave the agent, one row per value, with the projects that use it (or All
  projects), when it was saved and whether from chat or Settings, and a
  **folder missing** tag for a project that moved. Add a key, replace a
  value, change its projects, or delete it; a value is never shown again
  after saving. Connectors can use a saved key as `${NAME}`.
- **Plugins page and live settings refresh (v3)** `[v3.0.0]` — Settings →
  Plugins lists each plugin with its provider, tool hooks and load errors,
  and flags v2 Python plugins that have no TypeScript port (v3 does not run
  them). A one-time notice appears when a plugin isn't running. Agents,
  skills, commands, snippets, plugins and `mcp.json` edited outside the app
  refresh in open windows immediately. MCP servers report their status as it
  changes instead of being polled. With v2 the UI keeps its previous
  behaviour.
- **Settings draft protection and mobile navigation** `[v2.11.0]` — unsaved
  drafts survive remote refreshes and edits made during a save. Shared settings
  pages and source editors ask before discarding changes on internal navigation
  or close. Mobile exposes every settings category in a grouped section picker.
  Nested confirmation dialogs keep keyboard focus and Escape handling in the
  innermost dialog; shared tabs support arrow keys and Home/End.
- **Grouped settings navigation with one save contract** `[v1.128.0]` — the
  settings sidebar is grouped into **Agents & tools**, **Models**, and
  **About** instead of one flat list. **Title generation**, **Summarization**
  and **Multimodal** are consolidated into a single **Automation** section whose
  three groups can be collapsed independently. The shared save bar saves edited
  groups together; validation in an untouched group does not block saving,
  while every edited group must be valid. Every section now saves the same
  way: a sticky bar appears only when there are unsaved edits, with Reset, Save,
  and a `Cmd/Ctrl+S` binding. Notifications no longer writes on toggle, and
  reopening Settings returns to the section you left.
- **Roomier Settings with General, Connection and About** `[v3.21.0]` — the old About
  page held four unrelated things and is now three pages in a new **App**
  group. **General** has theme and transcript style. **Connection** shows the
  backend servers and the add / edit server form
  directly on the page, using the same panel as the **Backend connection**
  dialog (both are called **Server** since `[v3.40.0]`). **About OpenAgentd**
  has the version, updates and community links.
  Every page shares one layout: a page header with actions, titled sections
  above their cards, label-left / control-right rows, and more space between
  fields. Server forms test and save from a footer row instead of buttons
  squeezed beside inputs. On phones Settings opens on a grouped list of
  sections; each opens full-screen with Back.
- **Links to openagentd.dev** `[v3.22.0]` — **Settings → About OpenAgentd**
  has a **Website** card that opens openagentd.dev, and its tagline now reads
  "The coding agent that shows its work". The desktop **Help** menu starts
  with **OpenAgentd Website**, and the macOS About panel links to
  openagentd.dev instead of GitHub.
- **Tidier Settings** `[v3.57.0]` — Settings has four groups, and each page's
  name matches what's on it. **Basics**: General, Models, Image and video,
  Desktop. **Agent**: Agents, Skills, Connectors, Plugins, Memory. **Work**:
  Sessions, Workspaces, Blocked files. **Devices**: Switch computer, Remote
  control. **About** sits on its own at the bottom of the sidebar.
  - **Browser** `[v3.62.0]`, under **Work**: the sites the agent may use in
    the Browser tab (ask for each new site or allow all, allowed sites,
    blocked sites), and in the desktop app on a Mac **Clear browsing data**.
  - **General** (was Appearance) has two headings: **Appearance** (theme,
    text size) and **Chat** (Detail, Open previews).
  - **Switch computer** (was Server; the same name as ⌘K → **Switch
    Computer…**) has one **Let other devices connect** section.
    It holds the network switch, its port, and the switch that lets your
    account's devices connect directly. The network key is called **This
    computer's access key**, so it isn't confused with the access key of a
    computer you add.
  - **About** shows this app's version, updates and community links, and the
    community links are plain rows. The server's version and its **Update to
    vX**, or what to do where the server runs when it can't update itself,
    are on the server's row in Switch computer.
  - **Remote control** has no headings named "Account". Signed out, the card
    is titled **Sign in**; closing and unavailable accounts show **Status**.
  - **One page, one way to save.** A page made only of switches and choices
    applies each change right away (General, Desktop, Workspaces, Plugins).
    A page with anything typed, like a field or an editor, saves everything on it from the
    save bar (Sessions, Blocked files, Image and video, Memory and the
    editors). The **Let agents message other workspaces** switch now applies
    right away, like the groups below it. **Memory** uses the save bar, with
    **Discard…** and ⌘S, instead of its own Save button.
  - Since `[v3.62.0]` Memory's **Delete page** and **Create** send one
    request however fast they are pressed (a double click used to end in an
    error toast), and Enter creates the page from the **New page** dialog.
  - **Typed text is never lost without asking.** Memory asks **Discard
    changes?** before it opens another page over unsaved edits. A fresh copy
    of the page, for example after the agent saves it, no longer replaces what
    you typed: Save reports the conflict instead. **New page** refuses a path
    that already exists. On Sessions, a part that can't load shows its own
    error and Retry while the other parts still work. The save bar also says
    why Save is off for Titles and Summaries.
  - **Editors look and behave alike.** The main agent is listed and titled
    **Main agent**, not by its file name `code`. An agent opens its editor
    as a skill or a connector does, so Back, the phone's swipe back and the
    sidebar highlight work the same for all three. Subagents, skills and
    connectors each delete from one **Delete subagent / skill / connector**
    row at the bottom of the editor. In a connector's form, the first part is
    **Connection**, and its on/off option is **Turned on**, so "Status" means only the
    running connection.
  - **Every search result lands on its setting.** Results scroll to text the
    page shows: **Sign in** and **Devices** on Remote control, **Let other
    devices connect** and **This computer's access key** on Switch computer,
    and **Version** for Check for updates, which used to land on nothing in the
    browser. A result named after a button, like **Add a computer by
    address**, focuses that button.
  - Section ids follow the names (`/settings/models`, `/settings/connectors`,
    `/settings/sessions`, `/settings/blocked_files`, `/settings/switch_computer`,
    `/settings/remote`). The old ids are gone *(deprecated)*: a link that
    uses one just opens Settings, and a remembered old section opens
    General. Search still finds every page by its earlier name.
- **Settings split into focused pages** `[v3.21.0]` — the long **Automation** page with
  collapsible groups is now four plain pages: **Workspaces** (workspace
  messages and groups), **Chat titles**, **Context** (summarization and idle
  sessions) and **Media generation**. Desktop gets its own **Network access**
  page in the **App** group, and a **Privacy & safety** group holds **Memory**
  and **Denied paths**. Notices on every page (failed MCP servers, plugin
  warnings, lint results, security caveats) share one callout style, used
  app-wide, and page copy is shorter. A saved link to the old Automation
  section opens Workspaces.
- **Roomier Scheduled tasks and Keyboard shortcuts**
  `[v3.21.0]` — these panels now use the same layout as Settings: titled
  sections above their cards, label-left / control-right rows, more space
  between fields, one notice style, and sentence-case labels. A scheduled
  task's detail reads Status, then **Delivery**, **Schedule**, **Prompt** and
  **Runs** (a failed last run shows as a notice under Runs). The create and
  edit forms group their fields into Task, Schedule, Prompt and Delivery, and
  save from a footer bar. The task list shows one row per task. The same
  layout applies in the review dock's Schedule tab.
  On phones the scheduler shows a single header, puts **Run now** and
  **Pause** in a bottom bar, uses full-width save buttons and a number pad
  for intervals and run limits, and shows long workspace paths and session
  IDs in full. Task rows drop their inline buttons on touch screens; tap a
  task for every action, or long-press it in the app.
- **Theme in Settings and the palette** `[v3.0.0, updated v3.21.0]` — Settings → General has an
  **Appearance** section with a System / Light / Dark choice, and the Command
  Palette has **Theme…**, a list of System, Light and Dark that marks the
  current one `[v3.21.0]`. The mobile drawer keeps its theme button.
- **Settings: one way to save, every setting findable** `[v3.40.0]`:
  - Every page of fields saves the same way: a bar appears once something
    changed, with **Discard…** and **Save** (`⌘S`/`Ctrl+S`). The agent,
    skill and MCP editors use it too, so their headers no longer carry a
    Save of their own. Switches still apply at once.
  - The search field finds single settings, not just pages: choosing one
    opens its page, scrolls to it and focuses it. Search works on phones
    too.
  - A provider's accounts are one list under "Tried in this order", with
    **Use first** to move one to the top. Since `[v3.63.0]` an open
    provider draws no box of its own inside the provider list: its keys or
    accounts are rows split by a hairline, and **Models · N available** is
    the provider's last row, the full width of the list, which opens the
    models under it. (Each was a bordered box inside the list's border.)
  - **Save** on a key checks it first; when the check fails it says why,
    with **Retry** and **Save anyway**.
  - The backend panel: selecting a server shows its details, **Use**
    switches to it, and the one in use is marked **In use**; a stopped
    built-in server offers **Start and use**.
  - The first-run card names the action ("Use Ollama"), and the section is
    called **Retention** (with "Local history" inside it).
  - Below 900px wide the Settings navigation shows icons only.
  - Settings opens with the cursor in its search field (in the page when
    the icons-only navigation hides the field), not on Close with its
    tooltip showing, and the card keeps the same gap above the status bar
    as below the header.
