---
name: oad/frontend-debug
description: Autonomously debug and verify the OpenAgentd web/Tauri frontend with browser-use — drive the real UI, inspect DOM/CSS/JS state, simulate the mobile keyboard, screenshot, and loop without waiting on the user.
---

Debug and verify a frontend change end-to-end by driving the running app yourself
with `browser-use`, so you are not blocked waiting for a human to test.

Use this skill whenever a frontend symptom needs live verification: focus/keyboard
behavior, layout/viewport math, composer/input bar, scroll position, component
state transitions, console errors, or "does the DOM/CSS actually end up the way I
intended". Pure logic can still be covered by `bun run test`; reach for browser-use
when you need real rendered UI state.

## What browser-use can and cannot verify here

- CAN: rendered DOM, computed CSS, live JS state (`window`, attributes, CSS vars,
  `document.activeElement`), click/type/keys interactions, console errors,
  screenshots, and logic that depends on real layout.
- CANNOT: true iOS WKWebView rendering, 60fps smoothness, or real soft-keyboard
  timing — browser-use runs **desktop Chromium**, not the Tauri iOS shell. For the
  final "does it *feel* smooth on a real device" sign-off, the human is still
  fastest. Verify the *logic and resulting DOM/CSS* here; hand off only the
  perceptual feel.

## Preconditions

1. Dev server must be up on `:5173`. Check, don't assume:
   ```bash
   lsof -ti:5173 >/dev/null 2>&1 && echo up || echo down
   ```
   If down, start it in the background (it proxies `/api` to `:8000`):
   ```bash
   cd web && bun dev   # run as a background process; wait for ":5173" to be listening
   ```
2. Confirm the tool is healthy: `browser-use doctor` (the missing `cloudflared`
   check is irrelevant — it is only for remote tunnels).

## Core loop

1. Open in a **named session** so every later command targets the same browser:
   ```bash
   browser-use --session fe open "http://localhost:5173/cockpit"
   ```
   `/cockpit` renders the real chat + composer (`FloatingInputBar`/`InputBar`); it
   auto-loads or creates a session. `/coding` is the coding variant. `/` is just the
   mode picker. A bare new context may land on the 404 page until the router
   restores a route — navigate to an explicit route instead of relying on `/`.
2. Discover element indices and aria-labels:
   ```bash
   browser-use --session fe state
   ```
   Filter for what you need, e.g. `... state | grep -iE "shell|message input|send"`.
3. Interact using indices from the latest `state`.
4. Verify with `eval` (state assertions) and/or `screenshot` (visual).
5. Fix code, then repeat from step 2 (`state` indices change after re-render).
6. Close when done: `browser-use --session fe close`.

## Hard-won rules for THIS app (follow these — they are non-obvious)

- **Controlled React inputs:** prefer `browser-use click <index>` then
  `browser-use type "..."`. Do NOT set `textarea.value` via `eval` — the native
  setter mutates the value but does not focus or sync React/overlay state
  reliably (the composer paints text via an overlay mirror, not the textarea
  glyphs).
- **The composer starts minimized on desktop.** Click the `Expand input bar`
  button (aria-label) first, then the textarea (`aria-label=Message input`) is
  interactive.
- **`eval` must return a STRING (or number), not an object.** A bare `({ ... })`
  object literal usually comes back as `None`/`[object Object]`. Two shapes that
  both work reliably:
  - one expression joined with `'|'`:
    ```bash
    browser-use --session fe eval "document.querySelector('textarea').getAttribute('aria-label') + '|' + document.querySelector('textarea').placeholder"
    ```
  - an IIFE that does work and **returns a string** (multi-statement is fine as
    long as the final `return` is a string):
    ```bash
    browser-use --session fe eval "(function(){ var sc=document.getElementById('main').querySelector('.overflow-y-auto'); return 'distBottom='+(sc.scrollHeight-sc.scrollTop-sc.clientHeight); })()"
    ```
  Wrap object data with `JSON.stringify(...)` if you need structured output.
- **Selectors match across the whole app — be specific.** `.overflow-y-auto` and
  `.max-w-3xl` exist in the sidebar AND the chat; a bare `querySelector` grabbed the
  sidebar and gave wrong numbers. Scope to the region: the chat scrollport is
  `document.getElementById('main').querySelector('.overflow-y-auto')`, and its
  content is that element's `firstElementChild`.
- **Screenshots need an ABSOLUTE path** (relative paths fail). Save under the
  workspace:
  ```bash
  mkdir -p .openagentd/browser-use
  browser-use --session fe screenshot "$(pwd)/.openagentd/browser-use/<name>.png"
  ```
  Then read the PNG back to inspect it. Clean up artifacts when finished
  (`rm -rf .openagentd/browser-use`) unless the user wants them kept.
- If a command errors or indices look stale, run `browser-use --session fe close`
  and reopen once.

## Verifying focus / keyboard / mobile behavior (the recurring class of bugs)

Focus retention on the shell↔normal toggle (regression-prone). After clicking the
`Use shell mode` button, the textarea must keep focus:
```bash
browser-use --session fe eval "document.querySelector('textarea').getAttribute('aria-label') + '|active=' + (document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('aria-label'))"
# PASS looks like:  Shell command input|active=Shell command input
```

Mobile keyboard / viewport binding. Desktop Chromium does not trigger the iOS
path, so **spoof it** and assert the CSS contract directly. The shell binds its
height to the `--app-vh` CSS variable when `data-mobile-shell` is set:
```bash
# Simulate "keyboard open shrinks the visible viewport to 460px":
browser-use --session fe eval "document.documentElement.setAttribute('data-mobile-shell','ios'); document.documentElement.style.setProperty('--app-vh','460px'); '' "
# Assert the shell actually bound to it:
browser-use --session fe eval "const e=document.querySelector('.mobile-viewport'); e ? getComputedStyle(e).height : 'no .mobile-viewport'"
# PASS:  460px
```
The relevant source: `web/src/hooks/use-mobile-viewport.ts` (writes `--app-vh`,
`--app-vt`, `data-keyboard-open`, `data-vp-anim`), `web/src/index.css` (`.mobile-viewport`
binding), `web/src/components/FloatingInputBar.tsx`, `web/src/components/InputBar.tsx`.

## Read the console without screenshots — the console tap

`eval` lets you wire up a buffer that captures `console.*`, errors, and rejections,
then read it back as text. This is the fastest way to "see" what the app is doing
and to read any `console.log` you add to the code during a debugging session.

Install it **immediately after every `open`/navigation** (a fresh page wipes it):
```bash
browser-use --session fe eval "(function(){ if(window.__oaTap) return 'already'; window.__oaLogs=[]; window.__oaTap=true; ['log','warn','error','info'].forEach(function(k){ var o=console[k].bind(console); console[k]=function(){ try{ window.__oaLogs.push(k+': '+Array.from(arguments).map(function(a){try{return typeof a==='object'?JSON.stringify(a):String(a)}catch(e){return String(a)}}).join(' ')); if(window.__oaLogs.length>500)window.__oaLogs.shift(); }catch(e){} return o.apply(null,arguments); }; }); window.addEventListener('error',function(e){window.__oaLogs.push('window.error: '+(e.message||e))}); window.addEventListener('unhandledrejection',function(e){window.__oaLogs.push('unhandledrejection: '+((e.reason&&e.reason.message)||e.reason))}); return 'tap installed'; })()"
```
Read it back any time (filter as needed):
```bash
browser-use --session fe eval "(window.__oaLogs||[]).slice(-15).join(' || ') || 'no logs'"
browser-use --session fe eval "(window.__oaLogs||[]).filter(function(l){return /error|warn|exception/i.test(l)}).slice(-10).join(' || ') || 'no errors'"
```
Workflow: add temporary `console.log('[scroll] pinned=', pinnedRef.current, 'dist=', dist)`
in the component, let Vite HMR apply it, drive the UI, then dump `__oaLogs`. Remove
the logs before committing.

## Simulating runtime state without a backend

Some UI needs backend state that is awkward to set up (a coding workspace with open
files, a live agent stream). You can often exercise the *frontend logic* directly:

- **Simulate a streaming/content-growth scroll:** append a tall spacer to the chat
  content and confirm the auto-stick catches up.
  ```bash
  # grow content while pinned → ResizeObserver should re-stick to bottom
  browser-use --session fe eval "(function(){ var sc=document.getElementById('main').querySelector('.overflow-y-auto'); var sp=document.createElement('div'); sp.id='oa-spacer'; sp.style.height='1500px'; sc.firstElementChild.appendChild(sp); return 'grew'; })()"
  # wait a beat, then assert it re-stuck:
  browser-use --session fe eval "(function(){ var sc=document.getElementById('main').querySelector('.overflow-y-auto'); return 'distBottom='+(sc.scrollHeight-sc.scrollTop-sc.clientHeight); })()"  # PASS: 0
  # clean up: remove #oa-spacer
  ```
- **Simulate the mobile keyboard:** see the viewport section below.
- Always **remove injected test DOM** before finishing so a screenshot or a human
  check isn't confused by leftovers.

Note these are DOM-level simulations: they validate the *handler/CSS logic* (the
common root cause), not the real data flow. State that truly needs the backend
(routes like `/coding` show "No workspace attached" without one) still needs either
a seeded workspace or a device/human check.

## Reporting

Report: route(s) exercised, the interactions performed, the concrete `eval`
assertions with their PASS/FAIL values, any screenshot paths, console errors, and
explicitly call out what was NOT verified (always note that WKWebView smoothness /
real keyboard timing is unverified and needs a device check).

## Pair with the standard checks

browser-use complements, does not replace, the repo checks. For any frontend change
also run, from `web/`:
```bash
bun run lint
bun run typecheck
bun run test
```
