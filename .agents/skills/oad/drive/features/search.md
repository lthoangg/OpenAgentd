# Search result card

The agent's `grep` tool searches file contents. Its row in the transcript
shows what it found: the matching lines, the lines around each one when the
call asked for them, and a note when the result stops at its limit.

## Sub-features

- The count is of matches ("1 match", "3 matches"), not of lines shown.
- A match reads `file:12: text` and opens the file at that line. The lines
  around it read `file-11- text`, quieter, and a thin rule separates groups
  that are not next to each other.
- A result cut at `max_results` ends with a note under the list: how many
  lines match in all, and which files hold the rest.
- A search that found nothing, or an old result that is a plain list, shows
  as a list of entries as before.

## How to get to it (user POV)

- The row appears in the turn where the agent called `grep`. Click or tap it
  to open it.
- In Simple detail the turn's work is folded behind one line first ("1
  search"); open that line to reach the row.

## Driving it with Playwright

- `drive:grep <JSON arguments>` in a prompt makes the stub call `grep` with
  them, e.g. `{"pattern": "needle", "context": 2}`.
- The row is button "Expand grep details". A session with two searches has
  two; the journey opens the last one.
- The prompt bubble holds the pattern too, so check a result line by its
  whole text (`file:3: …`), which the prompt never contains.
- Rows carry `data-line` ("match", "context", "gap") for counting kinds; a
  line's text is the user-visible check.
- Cross-check: read the stored result from history, or from
  `/agent/<session>/tool-results/<tool_call_id>` when history left it out.

## Gotchas

- An instance with no sessions starts in Simple detail, and one with
  sessions in Full. The journey opens the fold when it is there.
- Search for text that only the journey's own files hold (put `ctx.run` in
  it): the demo repository keeps earlier runs' files.
- The pattern of the cut search ends in a space, so it matches the file's
  lines and not the prompt saved in any transcript file.
