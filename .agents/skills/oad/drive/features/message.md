# Send a message

Start a session in a folder, send a prompt, and read the agent's reply as it
streams.

## Sub-features

- Opening a folder as a workspace, with the "Let agents work in …?" consent.
- The composer: message input, Send, the model chip.
- The slash menu: Return from a phone keyboard picks the highlighted command.
- A failed action's toast: an undo the server refuses says "Couldn't undo",
  then the server's reason.
- The transcript: the prompt bubble, the streamed reply, the turn footer.
- The session takes a title from its first prompt.

## How to get to it (user POV)

- **Desktop:** the app opens on a new session. The folder chip in the composer
  ("Folder: Chat. Change folder") opens a list; "Open workspace…" opens a
  folder browser on the server; "Open this folder" then "Allow and open".
- **Phone:** the app opens on the Sessions list. "New session" (bottom) opens
  the same composer; the folder chip is at the top of the screen.
- A folder opened once is listed in the folder chip and in the sidebar.

## Driving it with Playwright

- `ctx.newSessionInDemo()` does the folder steps for `code/demo`, through the
  browser the first time and from the list after.
- Composer: textbox "Message input", button "Send message".
- The turn has ended when the reply text is visible and "Send message" is
  back (it is "Stop generation" while a turn runs).
- Cross-check: `ctx.history(ctx.sessionId())` returns the stored messages.

## Gotchas

- A session started through the API also registers its folder, so the folder
  browser only appears on an instance where nothing has used `code/demo` yet.
  The helper handles both.
- The session id is in the address only after the first message is sent.
- An Android keyboard's Return reaches the page only as a `beforeinput`
  line-break input (keyCode 229, no Enter keydown). No Playwright key press
  produces that, so the journey dispatches the input event itself; a real
  device check is still owed (backlog slash-menu-touch-return).
- `/undo` is not in the slash menu while a turn runs, so the store's "Cannot
  undo while agents are working" refusal cannot be reached from the menu; the
  journey fails the request instead (`page.route` on `**/agent/commands`).
