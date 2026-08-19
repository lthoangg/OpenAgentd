import { describe, it, expect } from "bun:test";
import { formatTokens, formatRelativeDate, formatDate, isSleepMessage, extractSleepPrefix, shortId, formatTime, lastTurnText } from "@/utils/format";

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------

describe("formatTokens", () => {
  it("returns plain number below 1000", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats 1000 as 1k", () => {
    expect(formatTokens(1000)).toBe("1k");
  });

  it("formats 1500 as 1.5k", () => {
    expect(formatTokens(1500)).toBe("1.5k");
  });

  it("strips trailing .0 from k suffix", () => {
    expect(formatTokens(2000)).toBe("2k");
    expect(formatTokens(10000)).toBe("10k");
  });

  it("formats large numbers", () => {
    expect(formatTokens(120000)).toBe("120k");
  });
});

// ---------------------------------------------------------------------------
// formatRelativeDate
// ---------------------------------------------------------------------------

describe("formatRelativeDate", () => {
  it("returns empty string for null", () => {
    expect(formatRelativeDate(null)).toBe("");
  });

  it("returns 'Today HH:mm' for a date earlier today", () => {
    const now = new Date();
    // Me set time to 3am today so it is clearly today regardless of timezone
    const todayEarly = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 3, 5);
    const result = formatRelativeDate(todayEarly.toISOString());
    expect(result).toMatch(/^Today \d{2}:\d{2}$/);
  });

  it("returns 'Yesterday HH:mm' for a date yesterday", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(14, 30, 0, 0);
    const result = formatRelativeDate(yesterday.toISOString());
    expect(result).toMatch(/^Yesterday \d{2}:\d{2}$/);
  });

  it("returns 'DD/MM/YYYY HH:mm' for older dates", () => {
    const old = new Date(2024, 0, 15, 9, 5); // 15 Jan 2024 09:05
    const result = formatRelativeDate(old.toISOString());
    expect(result).toBe("15/01/2024 09:05");
  });

  it("pads single-digit day and month", () => {
    const old = new Date(2023, 2, 5, 8, 3); // 5 Mar 2023 08:03
    const result = formatRelativeDate(old.toISOString());
    expect(result).toBe("05/03/2023 08:03");
  });
});

// ---------------------------------------------------------------------------
// formatDate
// ---------------------------------------------------------------------------

describe("formatDate", () => {
  it("parses ISO string into Date", () => {
    const iso = "2024-06-01T10:30:00.000Z";
    const result = formatDate(iso);
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBe(new Date(iso).getTime());
  });

  it("returns a Date instance for null (fallback to now)", () => {
    const before = Date.now();
    const result = formatDate(null);
    const after = Date.now();
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.getTime()).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// extractSleepPrefix
// ---------------------------------------------------------------------------

describe("extractSleepPrefix", () => {
  it("returns empty string for bare '<sleep>'", () => {
    expect(extractSleepPrefix("<sleep>")).toBe("");
  });

  it("returns empty string for bare '[sleep]'", () => {
    expect(extractSleepPrefix("[sleep]")).toBe("");
  });

  it("returns prefix text when content precedes sentinel", () => {
    expect(extractSleepPrefix("hello <sleep>")).toBe("hello");
    expect(extractSleepPrefix("some text [sleep]")).toBe("some text");
  });

  it("trims trailing whitespace from the prefix", () => {
    expect(extractSleepPrefix("hello   <sleep>")).toBe("hello");
    expect(extractSleepPrefix("hi\n[sleep]")).toBe("hi");
  });

  it("returns null for empty string", () => {
    expect(extractSleepPrefix("")).toBeNull();
  });

  it("returns null for plain text without sentinel", () => {
    expect(extractSleepPrefix("hello")).toBeNull();
  });

  it("returns null when sentinel is not at end", () => {
    expect(extractSleepPrefix("<sleep> extra")).toBeNull();
    expect(extractSleepPrefix("[sleep] trailing")).toBeNull();
  });

  it("returns null for wrong casing", () => {
    expect(extractSleepPrefix("<SLEEP>")).toBeNull();
    expect(extractSleepPrefix("[SLEEP]")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isSleepMessage
// ---------------------------------------------------------------------------

describe("isSleepMessage", () => {
  it("returns true for '<sleep>'", () => {
    expect(isSleepMessage("<sleep>")).toBe(true);
  });

  it("returns true for '[sleep]'", () => {
    expect(isSleepMessage("[sleep]")).toBe(true);
  });

  it("returns true when content precedes sentinel", () => {
    expect(isSleepMessage("some text <sleep>")).toBe(true);
    expect(isSleepMessage("hello [sleep]")).toBe(true);
  });

  it("returns true when trailing whitespace follows sentinel", () => {
    expect(isSleepMessage("  <sleep>  ")).toBe(true);
    expect(isSleepMessage("\t[sleep]\n")).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isSleepMessage("")).toBe(false);
  });

  it("returns false for plain text", () => {
    expect(isSleepMessage("hello")).toBe(false);
  });

  it("returns false when sentinel is not at end", () => {
    expect(isSleepMessage("<sleep> extra")).toBe(false);
  });

  it("returns false for wrong casing", () => {
    expect(isSleepMessage("<SLEEP>")).toBe(false);
    expect(isSleepMessage("[SLEEP]")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shortId
// ---------------------------------------------------------------------------

describe("shortId", () => {
  it("returns the first 8 characters of a UUID", () => {
    expect(shortId("550e8400-e29b-41d4-a716-446655440000")).toBe("550e8400");
  });

  it("returns the first 8 characters of any string", () => {
    expect(shortId("abcdefghijklmnop")).toBe("abcdefgh");
  });

  it("returns the full string when shorter than 8 characters", () => {
    expect(shortId("abc")).toBe("abc");
  });

  it("returns empty string for empty input", () => {
    expect(shortId("")).toBe("");
  });

  it("returns exactly 8 characters when input is exactly 8", () => {
    expect(shortId("12345678")).toBe("12345678");
  });
});

// ---------------------------------------------------------------------------
// formatTime
// ---------------------------------------------------------------------------

describe("formatTime", () => {
  it("returns a non-empty string for a valid Date", () => {
    const date = new Date(2024, 0, 15, 14, 30, 0); // 2:30 PM
    const result = formatTime(date);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("formats morning times in 24-hour format", () => {
    const date = new Date(2024, 0, 15, 9, 5, 0); // 09:05
    const result = formatTime(date);
    expect(result).toMatch(/09:05/);
  });

  it("formats afternoon times in 24-hour format", () => {
    const date = new Date(2024, 0, 15, 15, 45, 0); // 15:45
    const result = formatTime(date);
    expect(result).toMatch(/15:45/);
  });

  it("formats minutes with two digits", () => {
    const date = new Date(2024, 0, 15, 10, 5, 0); // 10:05
    const result = formatTime(date);
    expect(result).toMatch(/05/);
  });

  it("formats midnight correctly", () => {
    const date = new Date(2024, 0, 15, 0, 0, 0); // 00:00
    const result = formatTime(date);
    expect(result).toMatch(/00:00/);
  });

  it("formats noon correctly", () => {
    const date = new Date(2024, 0, 15, 12, 0, 0); // 12:00
    const result = formatTime(date);
    expect(result).toMatch(/12:00/);
  });
});

// ---------------------------------------------------------------------------
// lastTurnText
// ---------------------------------------------------------------------------

function block(type: string, content: string) {
  return { id: "x", type, content } as import("@/api/types").ContentBlock;
}

describe("lastTurnText", () => {
  it("returns empty string for empty block list", () => {
    expect(lastTurnText([])).toBe("");
  });

  it("returns text from the only text block", () => {
    expect(lastTurnText([block("text", "hello")])).toBe("hello");
  });

  it("joins multiple text blocks with double newline", () => {
    const result = lastTurnText([block("text", "foo"), block("text", "bar")]);
    expect(result).toBe("foo\n\nbar");
  });

  it("ignores non-text blocks (thinking, tool, user)", () => {
    const blocks = [
      block("thinking", "reasoning"),
      block("tool", ""),
      block("text", "answer"),
    ];
    expect(lastTurnText(blocks)).toBe("answer");
  });

  it("only returns text after the last user block", () => {
    const blocks = [
      block("user", "question 1"),
      block("text", "reply 1"),
      block("user", "question 2"),
      block("text", "reply 2"),
    ];
    expect(lastTurnText(blocks)).toBe("reply 2");
  });

  it("skips a pure sleep-sentinel text block", () => {
    const blocks = [
      block("user", "hi"),
      block("text", "working on it <sleep>"),
      block("text", "done"),
    ];
    expect(lastTurnText(blocks)).toBe("working on it\n\ndone");
  });

  it("keeps prefix before sleep sentinel and continues with later text", () => {
    const blocks = [
      block("text", "thinking... <sleep>"),
      block("text", "final answer"),
    ];
    expect(lastTurnText(blocks)).toBe("thinking...\n\nfinal answer");
  });

  it("drops a text block that is only the sentinel", () => {
    const blocks = [
      block("text", "<sleep>"),
      block("text", "result"),
    ];
    expect(lastTurnText(blocks)).toBe("result");
  });

  it("handles no user block — treats all blocks as the last turn", () => {
    const blocks = [block("text", "a"), block("text", "b")];
    expect(lastTurnText(blocks)).toBe("a\n\nb");
  });

  it("returns empty string when last turn has no text blocks", () => {
    const blocks = [
      block("user", "hi"),
      block("tool", ""),
      block("thinking", "..."),
    ];
    expect(lastTurnText(blocks)).toBe("");
  });
});

describe("lastTurnText — only the final response after the last tool call", () => {
  it("drops narration text that precedes a tool call", () => {
    const blocks = [
      block("text", "Let me check that for you."),
      block("tool", ""),
      block("text", "Here is the answer."),
    ];
    expect(lastTurnText(blocks)).toBe("Here is the answer.");
  });

  it("keeps only the text after the last of several tool calls", () => {
    const blocks = [
      block("text", "plan"),
      block("tool", ""),
      block("text", "intermediate note"),
      block("tool", ""),
      block("text", "final answer"),
    ];
    expect(lastTurnText(blocks)).toBe("final answer");
  });

  it("joins multiple text blocks that all follow the last tool call", () => {
    const blocks = [
      block("tool", ""),
      block("text", "part one"),
      block("text", "part two"),
    ];
    expect(lastTurnText(blocks)).toBe("part one\n\npart two");
  });

  it("returns empty string when the turn ends on a tool call with no trailing text", () => {
    const blocks = [
      block("text", "working on it"),
      block("tool", ""),
    ];
    expect(lastTurnText(blocks)).toBe("");
  });
});
