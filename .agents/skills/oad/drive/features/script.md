# Script tool row

The agent's `script` tool runs code that calls its other tools in one step.
Its row in the transcript shows what ran: the code, the nested calls, and what
the script logged or returned.

## Sub-features

- The closed row: the script's description as its title.
- The open row: "code", "calls · N" (one line per nested call, with its time
  and size) and "result".
- The call count beside the title ("2 calls"), once the result has loaded.
- The same row after a reload, rebuilt from the stored result.
- Panels a nested call changes refresh as a direct call's would
  (`script-effects` journey): a nested `patch` lists its file in Git and a
  nested `todo` puts its task on the board, with no reload and still one
  script row. The live feed carries a `nested_tool_end` per nested call.

## How to get to it (user POV)

- The row appears in the turn where the agent called `script`. Click or tap it
  to open it.
- In Simple detail the turn's work is folded behind one line first ("1
  script"); open that line to reach the row.

## Driving it with Playwright

- `drive:script <code on one line>` in a prompt makes the stub call `script`
  with that code and the description "Drive script".
- The row is button "Expand script details" ("Collapse script details" once
  open). The nested calls are the list "Nested tool calls".
- The prompt bubble holds the code and the marker too. Check the code through
  role `code` and the output by its exact text, not by a substring of the page.
- Cross-check: history leaves a tool's result out (`result_omitted`); read it
  from `/agent/<session>/tool-results/<tool_call_id>`.

## Gotchas

- An instance with no sessions starts in Simple detail, and one with sessions
  in Full, so the first journey of a fresh sandbox sees the folded line and
  later ones do not. The journey opens the fold when it is there.
- The call count is not on a closed row that has never been opened: the row
  loads its result when it opens.
- The live trace while a script runs is not driven: the stub's script ends in
  a few milliseconds.
- Git also refreshes when a turn ends, so the journey's Git check passes even
  without `nested_tool_end`; the task-board check is the one that fails
  without it. Refreshing during a long script is covered by
  `useAgentStore.nestedToolEnd.test.ts`, not by a journey.
- Tasks are a Review panel view on desktop and a sheet from the header's
  Tasks button on a phone (not in the phone's "Open in Review panel" sheet).
  The demo repository keeps earlier runs' files, so check for this run's
  file rather than a change count.
