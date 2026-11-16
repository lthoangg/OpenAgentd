# Settings

Find a setting, change it, and have it stay changed.

## Sub-features

- The Settings dialog and its sections.
- Search, whose results name a section or a setting inside one.
- Device settings on the General page: theme and text size.

## How to get to it (user POV)

- **Desktop:** "Settings" in the status bar at the bottom. Sections are on the
  left, the page on the right.
- **Phone:** "Settings" in the toolbar of the Sessions list. Sections are a
  list; a section opens as its own screen with "Back to Settings".

## Driving it with Playwright

- Dialog "Settings", searchbox "Search settings", list "Search results".
- A result for a setting is named "<setting>, in <section>".
- Theme: `html` gains the class `dark`. Text size: `html` gets
  `data-text-size`, and the text on the page grows.
- After a reload both are still set (they are stored in the browser).

## Gotchas

- On a phone, Settings reopens on the section list, not on the last page.
- Settings stored on the server (models, agents, blocked files) are not
  driven by this journey.
