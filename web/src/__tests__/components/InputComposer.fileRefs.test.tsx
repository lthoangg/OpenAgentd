/**
 * Tests for the InputComposer's @-mention file/folder picker.
 *
 * Covers:
 *   - ``findActiveMention`` pure helper (caret-aware token detection)
 *   - Popover open/close on typing
 *   - Filtering by partial token
 *   - Selection via Enter and click
 *   - Esc dismisses without inserting
 */
import { describe, it, expect, afterEach } from "bun:test"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { InputComposer, type FileRef } from "@/components/InputComposer"
import {
  findActiveMention,
  findCommittedMentions,
  buildMentionLookup,
  rankFileRefs,
} from "@/components/InputComposer.mentions"

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
      { path: "src/components/Sidebar.tsx", name: "Sidebar.tsx", type: "file" },
      { path: "src/api/client.ts", name: "client.ts", type: "file" },
    ]
    // ``ibar`` should pick up ``Sidebar`` (s-I-debar).
    const out = rankFileRefs(refs, "ibar", 20)
    expect(out[0].path).toBe("src/components/Sidebar.tsx")
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

  it("keeps a nested dir-name match below a perfect file match", () => {
    // Regression: the dir bonuses were sized for fuzzysort v2's large negative
    // scores. On v3's 0..1 scale the old +0.5 exact-name bonus was half the
    // whole range, so this nested dir (path score ~0.81 + 0.5) outranked a
    // perfect match on the file (1.0).
    const refs: FileRef[] = [
      { path: "deep/nested/place/src", name: "src", type: "directory" },
      { path: "src", name: "src", type: "file" },
    ]
    const out = rankFileRefs(refs, "src", 20)
    expect(out[0].path).toBe("src")
    expect(out[0].type).toBe("file")
  })

  it("rejects matches that share no ordered subsequence", () => {
    // ``xyz`` shares no characters in the right order with these paths, so
    // fuzzysort returns nothing at all — this does not exercise the threshold.
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
  const fxRefs: FileRef[] = [
    { path: "src/api.ts", name: "api.ts", type: "file" },
    { path: "a.ts", name: "a.ts", type: "file" },
    { path: "b/c.ts", name: "c.ts", type: "file" },
    { path: "my file.txt", name: "my file.txt", type: "file" },
  ]

  it("finds explicit mentions when mentions array is provided", () => {
    const out = findCommittedMentions("hi @src/api.ts and @a.ts", null, fxRefs, ["src/api.ts", "a.ts"])
    expect(out).toEqual([
      { start: 3, end: 14 },
      { start: 19, end: 24 },
    ])
  })

  it("finds explicit mentions with spaces", () => {
    const out = findCommittedMentions("please check @my file.txt", null, fxRefs, ["my file.txt"])
    expect(out).toEqual([
      { start: 13, end: 25 },
    ])
  })

  it("excludes the active range so the editing token doesn't flash", () => {
    const out = findCommittedMentions("hello @src/api.ts", { start: 6, end: 17 }, fxRefs, ["src/api.ts"])
    expect(out).toEqual([])
  })

  it("returns empty array when mentions array is an empty list (explicit-list mode)", () => {
    // An explicit empty mentions array means nothing was selected from the picker.
    expect(findCommittedMentions("hi @src/api.ts", null, fxRefs, [])).toEqual([])
  })

  it("uses scanner mode and finds tokens when mentions is undefined (historical messages)", () => {
    // No mentions list → scanner mode. Any @token in the text is highlighted.
    const out = findCommittedMentions("hi @src/api.ts", null, fxRefs)
    expect(out).toEqual([{ start: 3, end: 14 }])
  })
})

// ── Unit: buildMentionLookup (per-keystroke perf optimisation) ─────────────

describe("buildMentionLookup", () => {
  const fxRefs: FileRef[] = [
    { path: "src/api.ts", name: "api.ts", type: "file" },
    { path: "a.ts", name: "a.ts", type: "file" },
    { path: "src", name: "src", type: "directory" },
  ]

  it("includes @path for files and @path + @path/ for directories", () => {
    const lookup = buildMentionLookup(fxRefs)
    expect(lookup.valid.has("@src/api.ts")).toBe(true)
    expect(lookup.valid.has("@a.ts")).toBe(true)
    expect(lookup.valid.has("@src")).toBe(true)
    expect(lookup.valid.has("@src/")).toBe(true)
    // Line bases are file-only — used to validate @file#L1-L2 refs.
    expect(lookup.validLineBases.has("@src/api.ts")).toBe(true)
    expect(lookup.validLineBases.has("@src")).toBe(false)
  })

  it("a prebuilt lookup resolves mentions identically to passing refs", () => {
    // This is the optimisation the overlay relies on: build the sets once
    // and reuse them across keystrokes instead of rebuilding per call.
    const lookup = buildMentionLookup(fxRefs)
    const value = "see @src/api.ts and @a.ts here"
    expect(findCommittedMentions(value, null, lookup, ["src/api.ts", "a.ts"])).toEqual(
      findCommittedMentions(value, null, fxRefs, ["src/api.ts", "a.ts"]),
    )
  })

  it("a prebuilt lookup still validates line-reference mentions", () => {
    const lookup = buildMentionLookup(fxRefs)
    const out = findCommittedMentions("hi @src/api.ts#L2-L4", null, lookup, ["src/api.ts#L2-L4"])
    expect(out).toEqual([{ start: 3, end: 20 }])
  })

  it("a prebuilt lookup rejects unresolved tokens just like refs", () => {
    const lookup = buildMentionLookup(fxRefs)
    expect(findCommittedMentions("see @nonexistent x", null, lookup, ["nonexistent"])).toEqual([])
  })
})

// ── Integration: popover behaviour ────────────────────────────────────────

const fixtures: FileRef[] = [
  { path: "src/api.ts", name: "api.ts", type: "file" },
  { path: "src/index.ts", name: "index.ts", type: "file" },
  { path: "docs/intro.md", name: "intro.md", type: "file" },
  { path: "src", name: "src", type: "directory" },
]

describe("InputComposer — @-mention picker", () => {
  it("opens the popover when the user types @", async () => {
    const user = userEvent.setup()
    render(<InputComposer onSubmit={() => {}} fileRefs={fixtures} />)
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
    render(<InputComposer onSubmit={() => {}} fileRefs={fixtures} />)
    const textarea = screen.getByLabelText("Message input")

    await user.click(textarea)
    await user.type(textarea, "@docs")

    const options = screen.getAllByRole("option")
    expect(options).toHaveLength(1)
    expect(options[0].textContent).toContain("docs/intro.md")
  })

  it("does not open when @ is preceded by a non-whitespace char", async () => {
    const user = userEvent.setup()
    render(<InputComposer onSubmit={() => {}} fileRefs={fixtures} />)
    const textarea = screen.getByLabelText("Message input")

    await user.type(textarea, "user@domain")

    expect(screen.queryByRole("listbox", { name: "Reference workspace file" })).toBeNull()
  })

  it("inserts the path on Enter and closes the popover", async () => {
    const user = userEvent.setup()
    render(<InputComposer onSubmit={() => {}} fileRefs={fixtures} />)
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
    render(<InputComposer onSubmit={() => {}} fileRefs={fixtures} />)
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
      render(<InputComposer onSubmit={() => {}} fileRefs={many} />)
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
    render(<InputComposer onSubmit={() => {}} fileRefs={fixtures} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    await user.type(textarea, "@sr")
    await user.keyboard("{Escape}")

    expect(screen.queryByRole("listbox", { name: "Reference workspace file" })).toBeNull()
    // Text remains untouched.
    expect(textarea.value).toBe("@sr")
  })

  it("wires the active file mention option to the textarea", async () => {
    const user = userEvent.setup()
    render(<InputComposer onSubmit={() => {}} fileRefs={fixtures} />)
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
    render(<InputComposer onSubmit={() => {}} fileRefs={[]} />)
    const textarea = screen.getByLabelText("Message input")

    await user.type(textarea, "@foo")

    expect(screen.queryByRole("listbox", { name: "Reference workspace file" })).toBeNull()
  })

  it("Enter inserts the mention rather than submitting the message", async () => {
    const user = userEvent.setup()
    let submitted = ""
    render(
      <InputComposer
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
      <InputComposer
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
    render(<InputComposer onSubmit={() => {}} fileRefs={fixtures} />)
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
    render(<InputComposer onSubmit={() => {}} fileRefs={fixtures} />)
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

  it("atomically selects the whole mention when the caret returns into it", async () => {
    // Atomic-selection behaviour: when the user clicks or arrows back inside
    // a committed ``@mention``, ``syncMention`` selects the entire token so
    // that any subsequent edit or deletion applies to the whole path at once.
    // The picker does NOT reopen in this case — that was superseded by the
    // atomic-selection feature.
    const user = userEvent.setup()
    render(<InputComposer onSubmit={() => {}} fileRefs={fixtures} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    await user.type(textarea, "@sr")
    await user.keyboard("{ArrowDown}{Enter}") // inserts "@src/api.ts "
    expect(textarea.value).toBe("@src/api.ts ")
    expect(screen.queryByRole("listbox", { name: "Reference workspace file" })).toBeNull()

    // Move caret back inside the mention (between "ap" and "i.ts"). Using
    // ``fireEvent.select`` because React's synthetic ``onSelect`` is what
    // ``InputComposer`` listens to; a bare DOM ``select`` event doesn't reach
    // the synthetic handler under jsdom.
    textarea.setSelectionRange(7, 7)
    fireEvent.select(textarea)

    // Picker stays closed — atomic selection took over.
    expect(screen.queryByRole("listbox", { name: "Reference workspace file" })).toBeNull()
    // The whole token should be selected (0 → 11 = "@src/api.ts").
    // Selection is deferred via requestAnimationFrame so we use waitFor.
    await waitFor(() => {
      expect(textarea.selectionStart).toBe(0)
      expect(textarea.selectionEnd).toBe(11)
    })
  })

  it("chips a mention that arrived via paste, not through the picker", async () => {
    // The picker is one entry point; users can also paste a path or type
    // it manually. The overlay must rely on the value text itself, not on
    // any picker state, so pasted mentions get the same visual treatment.
    const user = userEvent.setup()
    render(<InputComposer onSubmit={() => {}} fileRefs={fixtures} />)
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
    render(<InputComposer onSubmit={() => {}} fileRefs={fixtures} />)
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
    render(<InputComposer onSubmit={() => {}} fileRefs={fixtures} />)
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

// ── Atomic mention selection ───────────────────────────────────────────────

describe("InputComposer — atomic mention selection", () => {
  it("selects the whole token when the caret moves into a committed mention", async () => {
    const user = userEvent.setup()
    render(<InputComposer onSubmit={() => {}} fileRefs={fixtures} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    // Insert a mention and move past it.
    await user.type(textarea, "@sr")
    await user.keyboard("{ArrowDown}{Enter}") // inserts "@src/api.ts "
    expect(textarea.value).toBe("@src/api.ts ")

    // Place the caret in the middle of "@src/api.ts" (after the "/").
    textarea.setSelectionRange(5, 5)
    fireEvent.select(textarea)

    // syncMention defers via rAF; wait for the whole token to be selected.
    await waitFor(() => {
      expect(textarea.selectionStart).toBe(0)
      expect(textarea.selectionEnd).toBe(11) // "@src/api.ts" = 11 chars
    })
  })

  it("does not select-all when the caret is outside any committed mention", async () => {
    const user = userEvent.setup()
    render(<InputComposer onSubmit={() => {}} fileRefs={fixtures} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    await user.type(textarea, "@sr")
    await user.keyboard("{ArrowDown}{Enter}") // "@src/api.ts "
    await user.type(textarea, "then more text")

    // Place caret in "more text" (well outside the mention).
    const pos = textarea.value.indexOf("more")
    textarea.setSelectionRange(pos, pos)
    fireEvent.select(textarea)

    // After a short tick the caret should still be at ``pos`` — no selection
    // expansion should have occurred.
    await new Promise((r) => setTimeout(r, 32))
    expect(textarea.selectionStart).toBe(pos)
    expect(textarea.selectionEnd).toBe(pos)
  })
})

// ── Atomic mention deletion ────────────────────────────────────────────────

describe("InputComposer — atomic mention deletion", () => {
  it("Backspace inside a committed mention deletes the whole token", async () => {
    const user = userEvent.setup()
    render(<InputComposer onSubmit={() => {}} fileRefs={fixtures} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    await user.type(textarea, "read @sr")
    await user.keyboard("{ArrowDown}{Enter}") // → "read @src/api.ts "

    // Move caret back inside the mention (after the "/").
    textarea.setSelectionRange(10, 10) // inside "@src/api.ts"
    fireEvent.select(textarea)
    // Wait for atomic selection to settle.
    await waitFor(() => expect(textarea.selectionStart).toBe(5))

    // Press Backspace — should remove "@src/api.ts", not a single char.
    await user.keyboard("{Backspace}")

    expect(textarea.value).toBe("read  ")
    expect(screen.queryByTestId("mention-chip")).toBeNull()
  })

  it("Delete inside a committed mention deletes the whole token", async () => {
    const user = userEvent.setup()
    render(<InputComposer onSubmit={() => {}} fileRefs={fixtures} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    await user.type(textarea, "@sr")
    await user.keyboard("{ArrowDown}{Enter}") // → "@src/api.ts "

    // Place caret at the start of the mention (index 0).
    textarea.setSelectionRange(0, 0)
    fireEvent.select(textarea)

    await user.keyboard("{Delete}")

    expect(textarea.value).toBe(" ")
    expect(screen.queryByTestId("mention-chip")).toBeNull()
  })

  it("Backspace on the trailing space does not delete the mention token", async () => {
    // The trailing space is outside the range tracked by mentions, so an
    // ordinary backspace should remove only that space.
    const user = userEvent.setup()
    render(<InputComposer onSubmit={() => {}} fileRefs={fixtures} />)
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    await user.type(textarea, "@sr")
    await user.keyboard("{Enter}") // → "@src/ "

    expect(textarea.value).toBe("@src/ ")
    // Caret is after the trailing space; one Backspace removes the space.
    await user.keyboard("{Backspace}")
    expect(textarea.value).toBe("@src/")
  })
})

// ── Mention sync pruning ───────────────────────────────────────────────────

describe("InputComposer — mention sync pruning", () => {
  it("removes a mention from the tracked list when its token is manually deleted", async () => {
    // The ``mentions`` array is passed to ``onSubmit`` as ``mentionedFiles``.
    // If the user types over or deletes a mention token, that path must not
    // appear in the submitted list — otherwise the backend would treat a
    // removed reference as still intentional.
    const user = userEvent.setup()
    const captured: string[] = []
    render(
      <InputComposer
        onSubmit={(_msg: string, _files?: File[], mentionedFiles?: string[]) => {
          if (mentionedFiles) captured.push(...mentionedFiles)
        }}
        fileRefs={fixtures}
      />
    )
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    // Insert a mention then delete it by selecting-all and retyping.
    await user.type(textarea, "@sr")
    await user.keyboard("{ArrowDown}{Enter}") // "@src/api.ts "
    await user.keyboard("{Control>}a{/Control}") // select all
    await user.keyboard("{Backspace}") // delete everything
    await user.type(textarea, "no mentions here")
    await user.keyboard("{Enter}") // submit via Enter

    expect(captured).toHaveLength(0)
  })

  it("keeps only the mentions that survive in the final text at submit time", async () => {
    // Two mentions inserted; one is then manually cleared by selecting and
    // deleting its token. Only the surviving one should arrive in
    // ``mentionedFiles``.
    const user = userEvent.setup()
    let capturedMentions: string[] | undefined
    render(
      <InputComposer
        onSubmit={(_msg: string, _files?: File[], mentionedFiles?: string[]) => {
          capturedMentions = mentionedFiles
        }}
        fileRefs={fixtures}
      />
    )
    const textarea = screen.getByLabelText("Message input") as HTMLTextAreaElement

    await user.type(textarea, "@src")
    await user.keyboard("{Enter}")           // → "@src/ "
    await user.type(textarea, "and @doc")
    await user.keyboard("{Enter}")           // → "@src/ and @docs/intro.md "

    // Manually select the "@src/" token and delete it. Place caret inside
    // it (after the "@") and use Backspace in atomic-deletion mode.
    textarea.setSelectionRange(2, 2) // caret inside "@src/"
    fireEvent.select(textarea)
    // Atomic-selection rAF: the whole token becomes selected then we delete.
    await waitFor(() => {
      // Either atomic selection has fired, or the caret is still at 2 —
      // either way we can proceed by explicitly selecting "@src/ " and
      // deleting it.
    })
    // Explicitly select "@src/ " (indices 0–6) and delete.
    textarea.setSelectionRange(0, 6)
    fireEvent.select(textarea)
    await user.keyboard("{Backspace}")

    // Submit.
    await user.click(screen.getByLabelText("Send message"))
    await waitFor(() => expect(capturedMentions).toBeDefined())

    expect(capturedMentions).not.toContain("src")
    expect(capturedMentions).toContain("docs/intro.md")
  })
})
