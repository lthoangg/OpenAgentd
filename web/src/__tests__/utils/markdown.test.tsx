import { describe, it, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { fixNestedFences, extractText, MarkdownBlock } from "@/utils/markdown";

// ---------------------------------------------------------------------------
// fixNestedFences
// ---------------------------------------------------------------------------

describe("fixNestedFences", () => {
  // ── Plain text ─────────────────────────────────────────────────────────────

  it("passes plain text through unchanged", () => {
    const input = "Hello, world!\nThis is plain text.\nNo fences here.";
    expect(fixNestedFences(input)).toBe(input);
  });

  it("passes empty string through unchanged", () => {
    expect(fixNestedFences("")).toBe("");
  });

  // ── Simple fence (no nesting) ──────────────────────────────────────────────

  it("passes a simple code fence through unchanged when body has no long backtick runs", () => {
    // Body contains no backtick runs >= 3, so maxInner < openLen — no re-fencing
    const input = ["```python", "x = 1", "print(x)", "```"].join("\n");
    expect(fixNestedFences(input)).toBe(input);
  });

  it("passes a 4-backtick fence through unchanged when body has no long backtick runs", () => {
    const input = ["````js", "const x = 1;", "````"].join("\n");
    expect(fixNestedFences(input)).toBe(input);
  });

  it("preserves text before and after a simple fence", () => {
    const input = [
      "intro text",
      "```",
      "code here",
      "```",
      "outro text",
    ].join("\n");
    expect(fixNestedFences(input)).toBe(input);
  });

  // ── Unclosed fence — lines 63-65 ───────────────────────────────────────────

  it("emits unclosed fence opener as-is and continues (depth never reaches 0)", () => {
    // The opening ``` is never closed — depth stays at 1 after scanning all lines.
    // The opener line is pushed to result and i advances by 1 (lines 63-65).
    const input = ["```python", "x = 1", "y = 2"].join("\n");
    expect(fixNestedFences(input)).toBe(input);
  });

  it("emits unclosed fence opener as-is when j reaches end of lines", () => {
    // Opener with no closer at all — j hits lines.length, depth !== 0 branch fires.
    const input = "```\nsome code";
    expect(fixNestedFences(input)).toBe(input);
  });

  it("handles multiple lines after an unclosed fence opener", () => {
    // After emitting the unclosed opener, the loop continues with i++ and
    // processes the remaining lines as plain text.
    const input = ["```", "line one", "line two", "line three"].join("\n");
    expect(fixNestedFences(input)).toBe(input);
  });

  // ── Nested opener of same length — line 53 (depth++) ──────────────────────

  it("increments depth when a same-length fence with a language tag is encountered (line 53)", () => {
    // Inner ``` python (has lang tag → depth++) then bare ``` (depth--) then bare ``` (depth-- → 0).
    // Body contains no backtick runs >= openLen, so the block passes through unchanged.
    const input = [
      "```",           // outer opener, openLen=3, depth=1
      "```python",     // same length + lang → depth++ → 2  (line 53)
      "x = 1",
      "```",           // same length + no lang → depth-- → 1
      "more text",
      "```",           // same length + no lang → depth-- → 0 → break (true closer)
    ].join("\n");

    // Body = ["```python", "x = 1", "```", "more text"]
    // maxInner: longest backtick run in body = 3 (the inner ``` lines)
    // maxInner (3) >= openLen (3) → re-fence with 4 backticks
    const expected = [
      "````",          // newFence = 4 backticks
      "```python",
      "x = 1",
      "```",
      "more text",
      "````",
    ].join("\n");

    expect(fixNestedFences(input)).toBe(expected);
  });

  it("handles two nested openers of same length before closing (depth reaches 3)", () => {
    // Two same-length+lang openers push depth to 3; two bare closers bring it to 1;
    // final bare closer brings it to 0.
    const input = [
      "```",           // outer opener, depth=1
      "```md",         // same length + lang → depth=2  (line 53)
      "```js",         // same length + lang → depth=3  (line 53)
      "code",
      "```",           // bare → depth=2
      "```",           // bare → depth=1
      "```",           // bare → depth=0 → break
    ].join("\n");

    // Body = ["```md", "```js", "code", "```", "```"]
    // maxInner = 3 >= openLen 3 → re-fence with 4 backticks
    const expected = [
      "````",
      "```md",
      "```js",
      "code",
      "```",
      "```",
      "````",
    ].join("\n");

    expect(fixNestedFences(input)).toBe(expected);
  });

  // ── Re-fence with longer backtick run — lines 74-77 ───────────────────────

  it("re-fences when body contains a backtick run equal to openLen (lines 74-77)", () => {
    // Body has ``` (3 backticks) which equals openLen=3 → maxInner=3 >= 3 → re-fence with 4
    const input = [
      "```markdown",
      "Here is some code:",
      "```python",
      "print('hello')",
      "```",
      "End of example.",
      "```",
    ].join("\n");

    // The inner ```python (lang tag) → depth++; inner bare ``` → depth--; back to 1.
    // Then outer bare ``` → depth-- → 0 → break.
    // Body = ["Here is some code:", "```python", "print('hello')", "```", "End of example."]
    // maxInner = 3 (from ``` runs) >= openLen 3 → re-fence with 4 backticks
    const expected = [
      "````markdown",
      "Here is some code:",
      "```python",
      "print('hello')",
      "```",
      "End of example.",
      "````",
    ].join("\n");

    expect(fixNestedFences(input)).toBe(expected);
  });

  it("re-fences with maxInner+1 when body has a 4-backtick run inside a 3-backtick outer fence", () => {
    // Body contains ```` (4 backticks) → maxInner=4 >= openLen=3 → newFence = 5 backticks
    const input = [
      "```",
      "some text with ```` four backticks",
      "```",
    ].join("\n");

    const expected = [
      "`````",
      "some text with ```` four backticks",
      "`````",
    ].join("\n");

    expect(fixNestedFences(input)).toBe(expected);
  });

  it("re-fences with maxInner+1 when body has inline backtick runs longer than the fence", () => {
    // Body has ````` (5 backticks) → maxInner=5 >= openLen=3 → newFence = 6 backticks
    const input = [
      "```",
      "text with ````` five backticks inside",
      "```",
    ].join("\n");

    const expected = [
      "``````",
      "text with ````` five backticks inside",
      "``````",
    ].join("\n");

    expect(fixNestedFences(input)).toBe(expected);
  });

  it("preserves lang and rest on the re-fenced opener line (lines 75)", () => {
    // Verifies newFence + lang + rest is assembled correctly
    const input = [
      "```markdown extra-info",
      "```python",
      "x = 1",
      "```",
      "```",
    ].join("\n");

    // openFence="```", lang="markdown", rest=" extra-info"
    // inner ```python → depth++; inner bare ``` → depth--; outer bare ``` → depth=0 break
    // Body = ["```python", "x = 1", "```"]
    // maxInner=3 >= 3 → newFence="````"
    const expected = [
      "````markdown extra-info",
      "```python",
      "x = 1",
      "```",
      "````",
    ].join("\n");

    expect(fixNestedFences(input)).toBe(expected);
  });

  // ── Different fence lengths — no re-fencing needed ─────────────────────────

  it("does not re-fence when inner fence is shorter than outer (4 outer, 3 inner)", () => {
    // openLen=4; inner ``` has fLen=3 ≠ openLen → not counted for depth, pushed to body.
    // maxInner from body: 3 backtick run < openLen 4 → no re-fencing, passes through unchanged.
    const input = [
      "````",
      "```python",
      "x = 1",
      "```",
      "````",
    ].join("\n");

    expect(fixNestedFences(input)).toBe(input);
  });

  it("does not re-fence when body backtick runs are all shorter than openLen", () => {
    // Body has `` (2 backticks) → maxInner=2 < openLen=3 → no re-fencing
    const input = [
      "```",
      "use ``inline`` code",
      "```",
    ].join("\n");

    expect(fixNestedFences(input)).toBe(input);
  });

  // ── Multiple separate code blocks ──────────────────────────────────────────

  it("handles multiple separate code blocks independently", () => {
    // First block: simple, no re-fencing needed.
    // Second block: body has ``` → re-fenced with 4 backticks.
    const input = [
      "```js",
      "const x = 1;",
      "```",
      "some text between",
      "```markdown",
      "```python",
      "y = 2",
      "```",
      "```",
    ].join("\n");

    // First block: body="const x = 1;" → maxInner=0 < 3 → unchanged
    // Second block: ```python (lang → depth++), bare ``` (depth--), outer bare ``` (depth=0 break)
    //   body=["```python","y = 2","```"] → maxInner=3 >= 3 → re-fence with 4
    const expected = [
      "```js",
      "const x = 1;",
      "```",
      "some text between",
      "````markdown",
      "```python",
      "y = 2",
      "```",
      "````",
    ].join("\n");

    expect(fixNestedFences(input)).toBe(expected);
  });

  it("handles two consecutive simple blocks both passing through unchanged", () => {
    const input = [
      "```",
      "block one",
      "```",
      "```",
      "block two",
      "```",
    ].join("\n");

    expect(fixNestedFences(input)).toBe(input);
  });

  it("handles plain text mixed with fenced blocks", () => {
    const input = [
      "Before",
      "```",
      "code",
      "```",
      "After",
    ].join("\n");

    expect(fixNestedFences(input)).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// extractText
// ---------------------------------------------------------------------------

describe("extractText", () => {
  it("returns a string input directly", () => {
    expect(extractText("hello world")).toBe("hello world");
  });

  it("returns empty string for an empty string input", () => {
    expect(extractText("")).toBe("");
  });

  it("joins an array of strings", () => {
    expect(extractText(["foo", "bar", "baz"])).toBe("foobarbaz");
  });

  it("returns empty string for an empty array", () => {
    expect(extractText([])).toBe("");
  });

  it("extracts text from an object with props.children string", () => {
    const node = { props: { children: "hello" } };
    expect(extractText(node)).toBe("hello");
  });

  it("extracts text from an object with props.children array", () => {
    const node = { props: { children: ["foo", " ", "bar"] } };
    expect(extractText(node)).toBe("foo bar");
  });

  it("extracts text from nested objects (props.children is another object)", () => {
    const node = {
      props: {
        children: {
          props: {
            children: "deep text",
          },
        },
      },
    };
    expect(extractText(node)).toBe("deep text");
  });

  it("handles deeply nested object tree", () => {
    const node = {
      props: {
        children: {
          props: {
            children: {
              props: {
                children: "very deep",
              },
            },
          },
        },
      },
    };
    expect(extractText(node)).toBe("very deep");
  });

  it("handles array of mixed strings and objects", () => {
    const node = [
      "prefix ",
      { props: { children: "middle" } },
      " suffix",
    ];
    expect(extractText(node)).toBe("prefix middle suffix");
  });

  it("handles array of nested objects", () => {
    const node = [
      { props: { children: "a" } },
      { props: { children: ["b", "c"] } },
    ];
    expect(extractText(node)).toBe("abc");
  });

  it("returns empty string for null", () => {
    expect(extractText(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(extractText(undefined)).toBe("");
  });

  it("returns empty string for a number", () => {
    expect(extractText(42)).toBe("");
  });

  it("returns empty string for a plain object without props", () => {
    expect(extractText({ foo: "bar" })).toBe("");
  });

  it("handles object with props.children undefined", () => {
    const node = { props: {} };
    expect(extractText(node)).toBe("");
  });

  it("handles object with props.children null", () => {
    const node = { props: { children: null } };
    expect(extractText(node)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// MarkdownBlock code fences
// ---------------------------------------------------------------------------

describe("MarkdownBlock code fences", () => {
  it("shows the fenced language in the code block header", () => {
    render(<MarkdownBlock content={["```ts", "const answer = 42", "```"].join("\n")} />);

    expect(screen.getByText("ts")).toBeTruthy();
    expect(document.querySelector("pre")?.textContent).toContain("const answer = 42");
  });

  it("does not show a code block header for an unlabeled fence", () => {
    render(<MarkdownBlock content={["```", "plain text", "```"].join("\n")} />);

    const pre = screen.getByText("plain text").closest("pre");
    expect(pre?.previousElementSibling?.textContent).not.toBe("plain text");
  });

  it("keeps code copy action visible and large enough for touch before desktop hover reveal", () => {
    render(<MarkdownBlock content={["```ts", "const answer = 42", "```"].join("\n")} />);

    const copyButton = screen.getByLabelText("Copy code");
    expect(copyButton.className).toContain("opacity-100");
    expect(copyButton.className).toContain("h-8");
    expect(copyButton.className).toContain("w-8");
    expect(copyButton.className).toContain("md:h-6");
    expect(copyButton.className).toContain("md:w-6");
    expect(copyButton.className).toContain("md:opacity-0");
    expect(copyButton.className).toContain("md:group-hover:opacity-100");
  });
});
