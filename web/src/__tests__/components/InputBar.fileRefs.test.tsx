/**
 * Tests for the InputBar's @-mention file/folder picker.
 *
 * Covers:
 *   - ``findActiveMention`` pure helper (caret-aware token detection)
 *   - Popover open/close on typing
 *   - Filtering by partial token
 *   - Selection via Enter and click
 *   - Esc dismisses without inserting
 */
import { describe, it, expect, afterEach } from "bun:test"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { InputBar, type FileRef } from "@/components/InputBar"
import {
  findActiveMention,
  findCommittedMentions,
  rankFileRefs,
} from "@/components/InputBar.mentions"

afterEach(cleanup)

// ── Unit: findActiveMention ────────────────────────────────────────────────

describe("findActiveMention", () => {
  it("returns null when no @ is before the caret", () => {
    expect(findActiveMention("hello world", 5)).toBeNull()
  })

  it("matches @ at the start of input", () => {
    const r = findActiveMention("@src", 4)
    expect(r).toEqual({ start: 0, end: 4, query: "src" })
  })

  it("matches @ after whitespace mid-sentence", () => {
    const r = findActiveMention("read @sr", 8)
    expect(r).toEqual({ start: 5, end: 8, query: "sr" })
  })

  it("returns null when @ is preceded by a non-space char (e.g. email-like)", () => {
    expect(findActiveMention("user@domain", 11)).toBeNull()
  })

  it("returns null when the token has been closed by whitespace", () => {
    expect(findActiveMention("@foo bar", 8)).toBeNull()
  })

  it("returns an empty query right after typing the @", () => {
    const r = findActiveMention("hi @", 4)
    expect(r).toEqual({ start: 3, end: 4, query: "" })
  })

  it("treats newlines as token terminators (multi-line input)", () => {
    // The textarea allows newlines; ``@foo`` on one line shouldn't pull
    // text from earlier lines into the query.
    const r = findActiveMention("first line\n@foo", 15)
    expect(r).toEqual({ start: 11, end: 15, query: "foo" })
  })

  it("treats tabs as token terminators", () => {
    // Defensive: tabs are uncommon in chat input but the regex matches
    // ``\s`` so they must work the same as spaces.
    const r = findActiveMention("hi\t@foo", 7)
    expect(r).toEqual({ start: 3, end: 7, query: "foo" })
  })

  it("uses the caret, not the end of the string, as the query boundary", () => {
    // User clicks back into ``@foo`` and the caret is between ``f`` and
    // ``o``. The query should be ``f``, not ``foo`` — that's what the
    // picker needs to re-narrow.
    const r = findActiveMention("@foo", 2)
    expect(r).toEqual({ start: 0, end: 2, query: "f" })
  })

  it("accepts path-like characters in the token (dots, slashes, hyphens)", () => {
    // Real workspace paths use all of these. The function must not stop
    // at any of them — only whitespace terminates the token.
    const r = findActiveMention("@docker-compose.yml", 19)
    expect(r).toEqual({ start: 0, end: 19, query: "docker-compose.yml" })
    const r2 = findActiveMention("@a/b/c.ts", 9)
    expect(r2).toEqual({ start: 0, end: 9, query: "a/b/c.ts" })
  })
})

// ── Unit: rankFileRefs ─────────────────────────────────────────────────────

describe("rankFileRefs", () => {
  const sample: FileRef[] = [
    { path: "src/api.ts", name: "api.ts", type: "file" },
    { path: "src/index.ts", name: "index.ts", type: "file" },
    { path: "src/utils/log.ts", name: "log.ts", type: "file" },
    { path: "docs/intro.md", name: "intro.md", type: "file" },
    { path: "src", name: "src", type: "directory" },
    { path: "src/utils", name: "utils", type: "directory" },
    { path: "docs", name: "docs", type: "directory" },
  ]

  it("with an empty query, surfaces top-level dirs first, sorted alphabetically", () => {
    const out = rankFileRefs(sample, "", 20)
    // Top-level dirs come first (``docs`` then ``src``, alphabetical), then
    // the rest in given order.
    expect(out[0]).toEqual({ path: "docs", name: "docs", type: "directory" })
    expect(out[1]).toEqual({ path: "src", name: "src", type: "directory" })
  })

  it("ranks an exact directory-name match above its children", () => {
    const out = rankFileRefs(sample, "src", 20)
    expect(out[0].type).toBe("directory")
    expect(out[0].path).toBe("src")
  })

  it("ranks a directory whose name starts with the query above its children", () => {
    const out = rankFileRefs(sample, "ut", 20)
    expect(out[0].type).toBe("directory")
    expect(out[0].path).toBe("src/utils")
  })

  it("ranks a file whose basename starts with the query above unrelated substring matches", () => {
    const out = rankFileRefs(sample, "api", 20)
    expect(out[0]).toEqual({ path: "src/api.ts", name: "api.ts", type: "file" })
  })

  it("filters out non-matches", () => {
    const out = rankFileRefs(sample, "zzz", 20)
    expect(out).toEqual([])
  })

  it("respects the limit", () => {
    const out = rankFileRefs(sample, "", 2)
    expect(out).toHaveLength(2)
  })

  it("prefers shorter paths within the same score band", () => {
    const refs: FileRef[] = [
      { path: "a/b/c/foo.ts", name: "foo.ts", type: "file" },
      { path: "foo.ts", name: "foo.ts", type: "file" },
    ]
    const out = rankFileRefs(refs, "foo", 20)
    expect(out[0].path).toBe("foo.ts")
    expect(out[1].path).toBe("a/b/c/foo.ts")
  })

  it("matches by fuzzy subsequence — dockcom finds docker-compose.yml", () => {
    const refs: FileRef[] = [
      { path: "docker-compose.yml", name: "docker-compose.yml", type: "file" },
      { path: "docs/intro.md", name: "intro.md", type: "file" },
      { path: "src/api.ts", name: "api.ts", type: "file" },
    ]
    const out = rankFileRefs(refs, "dockcom", 20)
    expect(out.length).toBeGreaterThan(0)
    expect(out[0].path).toBe("docker-compose.yml")
  })

  it("handles short non-prefix subsequences", () => {
    const refs: FileRef[] = [
      { path: "src/components/InputBar.tsx", name: "InputBar.tsx", type: "file" },
      { path: "src/api/client.ts", name: "client.ts", type: "file" },
    ]
    // ``ibar`` should pick up ``InputBar`` (I + Bar).
    const out = rankFileRefs(refs, "ibar", 20)
    expect(out[0].path).toBe("src/components/InputBar.tsx")
  })

  it("returns an empty list when the limit is 0", () => {
    // Defensive: a caller passing limit=0 must never see a result. The
    // function is used to bound popover height; off-by-one here would
    // leak a hidden option.
    const out = rankFileRefs(sample, "src", 0)
    expect(out).toEqual([])
  })

  it("treats a whitespace-only query as empty", () => {
    // ``"   "`` after the @ shouldn't trigger a fuzzy search against
    // every path. We trim and fall through to the empty-query branch.
    const out = rankFileRefs(sample, "   ", 20)
    expect(out[0]).toEqual({ path: "docs", name: "docs", type: "directory" })
    expect(out[1]).toEqual({ path: "src", name: "src", type: "directory" })
  })

  it("is case-insensitive", () => {
    // Workspace paths are case-preserved (POSIX), but users won't shift
    // to uppercase mid-mention. ``SRC`` should still find ``src``.
    const out = rankFileRefs(sample, "SRC", 20)
    expect(out[0].path).toBe("src")
  })

  it("disambiguates a directory and a file that share a name", () => {
    // Edge case: ``src`` exists as both a directory and a file. The
    // exact-name-match bonus should still surface the directory first
    // (typing the name alone usually means the dir).
    const refs: FileRef[] = [
      { path: "src.ts", name: "src.ts", type: "file" },
      { path: "src", name: "src", type: "directory" },
    ]
    const out = rankFileRefs(refs, "src", 20)
    expect(out[0]).toEqual({ path: "src", name: "src", type: "directory" })
  })

  it("rejects matches that fall below the fuzzysort threshold", () => {
    // ``xyz`` shares no characters in the right order with these paths.
    // We rely on fuzzysort + the 0.2 threshold to filter rather than
    // surfacing zero-score matches.
    const refs: FileRef[] = [
      { path: "src/api.ts", name: "api.ts", type: "file" },
      { path: "docs/intro.md", name: "intro.md", type: "file" },
    ]
    const out = rankFileRefs(refs, "xyz", 20)
    expect(out).toEqual([])
  })

  it("the dir bonus does not override a much stronger file match", () => {
    // Typing the exact basename of a file should put that file first,
    // even though a directory whose name *contains* the query exists.
    // This pins down "fuzzysort dominates, dir bonus only nudges ties".
    const refs: FileRef[] = [
      { path: "apidocs", name: "apidocs", type: "directory" },
      { path: "src/api.ts", name: "api.ts", type: "file" },
    ]
    const out = rankFileRefs(refs, "api.ts", 20)
    expect(out[0].path).toBe("src/api.ts")
  })

  it("empty-query result still respects the limit on the dirs-first branch", () => {
    // With many top-level dirs, the limit must cut into the alphabetical
    // dir list rather than overflow into ``rest``.
    const refs: FileRef[] = [
      { path: "a-dir", name: "a-dir", type: "directory" },
      { path: "b-dir", name: "b-dir", type: "directory" },
      { path: "c-dir", name: "c-dir", type: "directory" },
      { path: "z.ts", name: "z.ts", type: "file" },
    ]
    const out = rankFileRefs(refs, "", 2)
    expect(out).toEqual([
      { path: "a-dir", name: "a-dir", type: "directory" },
      { path: "b-dir", name: "b-dir", type: "directory" },
    ])
  })
})

// ── Unit: findCommittedMentions ───────────────────────────────────────────

describe("findCommittedMentions", () => {
  // Shared fixture: workspace contains a few real refs so the resolution
  // check has something to match against. ``a.ts``, ``b/c.ts`` exist as
  // files; ``aaa`` exists as both a file (``aaa``) and is referenced from
  // active-range tests below.
  const fxRefs: FileRef[] = [
    { path: "src/api.ts", name: "api.ts", type: "file" },
    { path: "a.ts", name: "a.ts", type: "file" },
    { path: "b/c.ts", name: "c.ts", type: "file" },
    { path: "aaa", name: "aaa", type: "file" },
    { path: "README.md", name: "README.md", type: "file" },
    { path: "src", name: "src", type: "directory" },
  ]

  it("finds a single trailing mention", () => {
    // ``"hi @src/api.ts"`` — no trailing whitespace, but the token still
    // counts as committed (end-of-string terminates it).
    const out = findCommittedMentions("hi @src/api.ts", null, fxRefs)
    expect(out).toEqual([{ start: 3, end: 14 }])
  })

  it("resolves committed line-reference mentions against the base file", () => {
    const out = findCommittedMentions("hi @src/api.ts#L2-L4", null, fxRefs)
    expect(out).toEqual([{ start: 3, end: 20 }])
  })

  it("finds multiple mentions", () => {
    const out = findCommittedMentions("see @a.ts and @b/c.ts please", null, fxRefs)
    expect(out).toEqual([
      { start: 4, end: 9 },
      { start: 14, end: 21 },
    ])
  })

  it("ignores email-like @ (no leading whitespace)", () => {
    const out = findCommittedMentions("ping user@host.com please", null, fxRefs)
    expect(out).toEqual([])
  })

  it("ignores a bare @ with nothing after it", () => {
    const out = findCommittedMentions("type @ here", null, fxRefs)
    expect(out).toEqual([])
  })

  it("excludes the active range so the editing token doesn't flash", () => {
    // ``"hello @sr"`` — user is mid-typing the second token.
    const out = findCommittedMentions("hello @sr", { start: 6, end: 9 }, fxRefs)
    expect(out).toEqual([])
  })

  it("keeps committed mentions even when an active range is provided", () => {
    // First token is committed (followed by whitespace), second is active.
    const out = findCommittedMentions(
      "ref @a.ts and @bb",
      { start: 14, end: 17 },
      fxRefs,
    )
    expect(out).toEqual([{ start: 4, end: 9 }])
  })

  it("handles mentions across newlines (multi-line input)", () => {
    // The textarea allows ``\n``. Each line's `@` should be detected
    // independently — a newline both terminates the previous token and
    // satisfies the "preceded by whitespace" rule for the next.
    const out = findCommittedMentions("first @a.ts\nsecond @b/c.ts", null, fxRefs)
    expect(out).toEqual([
      { start: 6, end: 11 },
      { start: 19, end: 26 },
    ])
  })

  it("excludes only the range whose start matches — not a substring overlap", () => {
    // The active-range predicate is ``activeRange.start === i``. If a
    // caller passes a stale range that happens to overlap a committed
    // mention without starting at its `@`, the committed mention must
    // still be returned.
    const out = findCommittedMentions(
      "ref @aaa bbb",
      { start: 5, end: 8 }, // inside ``@aaa``
      fxRefs,
    )
    expect(out).toEqual([{ start: 4, end: 8 }])
  })

  it("returns an empty array for an empty value (no work)", () => {
    expect(findCommittedMentions("", null, fxRefs)).toEqual([])
  })

  // ── Resolution-required behaviour (matches opencode's exact-match model) ──

  it("does not chip a token that doesn't resolve to a real workspace ref", () => {
    // ``@nonexistent`` — picker would never suggest this; user typed it
    // freehand. Highlighting it would falsely imply we'll attach the file.
    const out = findCommittedMentions("see @nonexistent please", null, fxRefs)
    expect(out).toEqual([])
  })

  it("does not chip the pathological double-@ token", () => {
    // ``@@`` is the originally reported bug: nothing resolves, so no chip.
    // The leading `@` is preceded by start-of-string (matches), the inner
    // `@` is preceded by another `@` (not whitespace — wouldn't trigger
    // on its own). Either way, no ref → no chip.
    const out = findCommittedMentions("@@", null, fxRefs)
    expect(out).toEqual([])
  })

  it("does not chip an @foo@bar token (mid-token @ doesn't resolve)", () => {
    // The whole thing scans to one token ``@foo@bar``; no ref matches it.
    const out = findCommittedMentions("look @foo@bar end", null, fxRefs)
    expect(out).toEqual([])
  })

  it("strips trailing sentence punctuation before resolving", () => {
    // ``"@README.md,"`` — the comma is prose, not part of the path. We
    // chip the path and leave the comma plain. Verifies the chip end
    // sits before the punctuation, not at it.
    const out = findCommittedMentions("look @README.md, please", null, fxRefs)
    expect(out).toEqual([{ start: 5, end: 15 }])
  })

  it("handles a parenthetical mention closer", () => {
    // ``"(@README.md)"`` — the open paren rejects the mention (preceded
    // by non-whitespace from the @'s perspective), so no chip. This
    // pins down that the leading-paren case stays out of scope; the
    // punctuation strip is *trailing* only.
    const out = findCommittedMentions("look(@README.md)", null, fxRefs)
    expect(out).toEqual([])
  })

  it("strips a chain of trailing punctuation", () => {
    // ``@README.md?!`` — strip both. Tests the loop, not just one char.
    const out = findCommittedMentions("@README.md?! next", null, fxRefs)
    expect(out).toEqual([{ start: 0, end: 10 }])
  })

  it("back-compat: omitting refs falls back to syntax-only matching", () => {
    // Some callers (none today, but reserve it) may want pure geometry
    // without resolution. Tested separately so the optional parameter's
    // semantics are explicit.
    const out = findCommittedMentions("see @anything")
    expect(out).toEqual([{ start: 4, end: 13 }])
  })
})

// ── Integration: popover behaviour ────────────────────────────────────────

const fixtures: FileRef[] = [
  { path: "src/api.ts", name: "api.ts", type: "file" },
  { path: "src/index.ts", name: "index.ts", type: "file" },
  { path: "docs/intro.md", name: "intro.md", type: "file" },
  { path: "src", name: "src", type: "directory" },
]

describe("InputBar — @-mention picker", () => {
  it("opens the popover when the user types @", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} fileRefs={fixtures} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    await user.click(textarea)
    await user.keyboard("@")

    const listbox = screen.getByRole("listbox", { name: "Reference workspace file" })
    expect(listbox).toBeTruthy()
    // All four refs visible while query is empty.
    expect(screen.getAllByRole("option")).toHaveLength(4)
  })

  it("filters the list as the user types", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} fileRefs={fixtures} />)
    const textarea = screen.getByLabelText("Message input")

    await user.click(textarea)
    await user.type(textarea, "@docs")

    const options = screen.getAllByRole("option")
    expect(options).toHaveLength(1)
    expect(options[0].textContent).toContain("docs/intro.md")
  })

  it("does not open when @ is preceded by a non-whitespace char", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} fileRefs={fixtures} />)
    const textarea = screen.getByLabelText("Message input")

    await user.type(textarea, "user@domain")

    expect(screen.queryByRole("listbox", { name: "Reference workspace file" })).toBeNull()
  })

  it("inserts the path on Enter and closes the popover", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} fileRefs={fixtures} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    // ``@sr`` ranks the directory ``src`` (name starts with the query) above
    // its children, so Enter inserts the dir with a trailing slash. ArrowDown
    // then Enter picks the first file under ``src``.
    await user.type(textarea, "read @sr")
    await user.keyboard("{ArrowDown}{Enter}")

    expect(textarea.value).toBe("read @src/api.ts ")
    expect(screen.queryByRole("listbox", { name: "Reference workspace file" })).toBeNull()

    // The inserted mention should be highlighted by the chip overlay so it
    // visually stands apart from regular prose. We only check that a chip
    // exists and that its text content equals the mention token — exact
    // colors / fonts are pure CSS and would be brittle to assert against.
    const chips = screen.getAllByTestId("mention-chip")
    expect(chips).toHaveLength(1)
    expect(chips[0].textContent).toBe("@src/api.ts")
  })

  it("ranks the matching directory above its children", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} fileRefs={fixtures} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    // Typing ``@src`` should put the ``src`` directory at the top of the
    // picker — an exact-name match outranks substring file matches.
    await user.type(textarea, "@src")
    await user.keyboard("{Enter}")

    expect(textarea.value).toBe("@src/ ")
  })

  it("scrolls the highlighted option into view when arrow-keying past the visible window", async () => {
    // Spy on scrollIntoView so we can assert the highlighted option is the
    // one being scrolled (jsdom's stub is a no-op, but the call still fires).
    const calls: HTMLElement[] = []
    const original = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      calls.push(this)
    }

    try {
      const many: FileRef[] = Array.from({ length: 12 }, (_, i) => ({
        path: `pkg/mod${i}.ts`,
        name: `mod${i}.ts`,
        type: "file",
      }))
      const user = userEvent.setup()
      render(<InputBar onSubmit={() => {}} fileRefs={many} />)
      const textarea = screen.getByLabelText("Message input")

      await user.type(textarea, "@pkg")
      // The picker is open with 12 results. ArrowDown five times.
      calls.length = 0
      await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}")

      const options = screen.getAllByRole("option")
      // Highlight is now on index 5; selection mirrors.
      expect(options[5].getAttribute("aria-selected")).toBe("true")
      // ``scrollIntoView`` was called and the most recent call was for the
      // newly-highlighted option (callback ref → effect chain settles to the
      // current selection by the end of the keyboard burst).
      expect(calls.length).toBeGreaterThan(0)
      expect(calls[calls.length - 1]).toBe(options[5])
    } finally {
      HTMLElement.prototype.scrollIntoView = original
    }
  })

  it("dismisses the popover on Esc without inserting", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} fileRefs={fixtures} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    await user.type(textarea, "@sr")
    await user.keyboard("{Escape}")

    expect(screen.queryByRole("listbox", { name: "Reference workspace file" })).toBeNull()
    // Text remains untouched.
    expect(textarea.value).toBe("@sr")
  })

  it("wires the active file mention option to the textarea", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} fileRefs={fixtures} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    await user.type(textarea, "@sr")

    const listbox = screen.getByRole("listbox", { name: "Reference workspace file" })
    const options = screen.getAllByRole("option")

    expect(textarea.getAttribute("aria-expanded")).toBe("true")
    expect(textarea.getAttribute("aria-controls")).toBe(listbox.id)
    expect(textarea.getAttribute("aria-activedescendant")).toBe(options[0].id)
    expect(options[0].getAttribute("aria-selected")).toBe("true")

    await user.keyboard("{ArrowDown}")
    expect(textarea.getAttribute("aria-activedescendant")).toBe(options[1].id)
  })

  it("does nothing when fileRefs is empty", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} fileRefs={[]} />)
    const textarea = screen.getByLabelText("Message input")

    await user.type(textarea, "@foo")

    expect(screen.queryByRole("listbox", { name: "Reference workspace file" })).toBeNull()
  })

  it("Enter inserts the mention rather than submitting the message", async () => {
    const user = userEvent.setup()
    let submitted = ""
    render(
      <InputBar
        onSubmit={(text) => { submitted = text }}
        fileRefs={fixtures}
      />
    )
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    await user.type(textarea, "look @doc")
    await user.keyboard("{Enter}")

    expect(submitted).toBe("")
    expect(textarea.value).toBe("look @docs/intro.md ")
  })

  it("closes the picker on submit so it does not linger over an empty textarea", async () => {
    const user = userEvent.setup()
    let submitted = ""
    render(
      <InputBar
        onSubmit={(text) => { submitted = text }}
        fileRefs={fixtures}
      />
    )
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    // Compose: insert a mention then keep typing so the picker reopens.
    // Ranking now puts the ``src`` directory above its files for the query
    // "src", so Enter inserts the dir.
    await user.type(textarea, "review @src")
    await user.keyboard("{Enter}") // selects the ``src`` directory
    expect(textarea.value).toBe("review @src/ ")
    // Type ``@inde`` after — picker should open again on the new token.
    await user.type(textarea, "@inde")
    expect(screen.getByRole("listbox", { name: "Reference workspace file" })).toBeTruthy()

    // Click the Send button to submit. The picker must close so it doesn't
    // hover over the now-empty textarea.
    await user.click(screen.getByLabelText("Send message"))

    expect(submitted).toBe("review @src/ @inde")
    expect(textarea.value).toBe("")
    expect(screen.queryByRole("listbox", { name: "Reference workspace file" })).toBeNull()
  })

  it("does not chip the actively-typed mention until it is committed", async () => {
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} fileRefs={fixtures} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    // While typing ``@sr`` the picker is open and the token at the caret is
    // *active*, not committed. The overlay must not render a chip there yet
    // — otherwise the user sees a colored background flash on every
    // keystroke before they've made a choice.
    await user.type(textarea, "@sr")
    expect(screen.queryByTestId("mention-chip")).toBeNull()

    // Insert the dir. Now there's a committed token followed by a space.
    await user.keyboard("{Enter}")
    expect(textarea.value).toBe("@src/ ")
    const chips = screen.getAllByTestId("mention-chip")
    expect(chips).toHaveLength(1)
    expect(chips[0].textContent).toBe("@src/")
  })

  it("renders one chip per committed mention when several are inserted", async () => {
    // Verifies the overlay enumerates all committed ranges, not just the
    // last one. Two separate Enter inserts.
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} fileRefs={fixtures} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    await user.type(textarea, "compare @src")
    await user.keyboard("{Enter}")            // → "compare @src/ "
    await user.type(textarea, "and @doc")
    await user.keyboard("{Enter}")            // → "compare @src/ and @docs/intro.md "

    expect(textarea.value).toBe("compare @src/ and @docs/intro.md ")
    const chips = screen.getAllByTestId("mention-chip")
    expect(chips).toHaveLength(2)
    expect(chips.map((c) => c.textContent)).toEqual(["@src/", "@docs/intro.md"])
  })

  it("re-opens the picker when the caret returns into an existing mention", async () => {
    // Edit existing mention: user inserts ``@src/api.ts ``, then clicks
    // back inside it. The picker should re-open because there's an active
    // mention at the caret again — that's the whole point of ``onSelect``
    // / ``syncMention``.
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} fileRefs={fixtures} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    await user.type(textarea, "@sr")
    await user.keyboard("{ArrowDown}{Enter}") // inserts "@src/api.ts "
    expect(textarea.value).toBe("@src/api.ts ")
    expect(screen.queryByRole("listbox", { name: "Reference workspace file" })).toBeNull()

    // Move caret back inside the mention (between "ap" and "i.ts"). Using
    // ``fireEvent.select`` because React's synthetic ``onSelect`` is what
    // ``InputBar`` listens to; a bare DOM ``select`` event doesn't reach
    // the synthetic handler under jsdom.
    textarea.setSelectionRange(7, 7)
    fireEvent.select(textarea)

    expect(
      screen.getByRole("listbox", { name: "Reference workspace file" }),
    ).toBeTruthy()
  })

  it("chips a mention that arrived via paste, not through the picker", async () => {
    // The picker is one entry point; users can also paste a path or type
    // it manually. The overlay must rely on the value text itself, not on
    // any picker state, so pasted mentions get the same visual treatment.
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} fileRefs={fixtures} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    // ``user.paste`` writes via the native input event, so it follows the
    // same code path a real Cmd+V would.
    await user.click(textarea)
    await user.paste("look at @src/api.ts please")

    expect(textarea.value).toBe("look at @src/api.ts please")
    const chips = screen.getAllByTestId("mention-chip")
    expect(chips).toHaveLength(1)
    expect(chips[0].textContent).toBe("@src/api.ts")
  })

  it("removes the chip when the user backspaces the trailing space and edits", async () => {
    // Tests the overlay's reactive recompute. Inserting a chip then
    // editing the value back to an active token must transition the
    // mention from committed → active, which removes the chip.
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} fileRefs={fixtures} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    await user.type(textarea, "@src")
    await user.keyboard("{Enter}")       // → "@src/ " — chip present
    expect(screen.getAllByTestId("mention-chip")).toHaveLength(1)

    // Backspace the trailing space. The caret is now flush against the
    // ``/``, so the mention becomes the active range again. The chip must
    // disappear so the user doesn't see a frozen pill while editing.
    await user.keyboard("{Backspace}")
    expect(textarea.value).toBe("@src/")
    expect(screen.queryByTestId("mention-chip")).toBeNull()
  })

  it("colors file mentions and folder mentions distinctly", async () => {
    // Files paint in --accent-blue-text, folders in --accent-orange-text.
    // We assert the kind via ``data-mention-kind`` (stable contract for
    // tests) and that the class names target different tokens, so a
    // future palette tweak doesn't require an exact-color test rewrite.
    const user = userEvent.setup()
    render(<InputBar onSubmit={() => {}} fileRefs={fixtures} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    // Insert one folder (``@src/``) and one file (``@docs/intro.md``).
    await user.type(textarea, "look @src")
    await user.keyboard("{Enter}")              // → "look @src/ "
    await user.type(textarea, "and @docs/intro")
    await user.keyboard("{Enter}")              // → "look @src/ and @docs/intro.md "

    const chips = screen.getAllByTestId("mention-chip")
    expect(chips).toHaveLength(2)

    const [folderChip, fileChip] = chips
    expect(folderChip.getAttribute("data-mention-kind")).toBe("directory")
    expect(folderChip.className).toContain("--accent-orange-text")
    expect(fileChip.getAttribute("data-mention-kind")).toBe("file")
    expect(fileChip.className).toContain("--accent-blue-text")
  })
})
