import { describe, it, expect } from "bun:test";
import { formatRelativeDate, formatCompactRelative, formatCompactDate, formatCompactUpcoming, isSleepMessage, extractSleepPrefix, shortId, formatTime, formatFullDateTime, lastTurnText, finalAnswerBlocks, getTimezoneOffsetMinutes, wallClockToISO, isoToWallClock, formatInTimezone } from "@/utils/format";
import { formatCommitTime } from "@/components/WorkspacePanel/diff-helpers";

// ---------------------------------------------------------------------------
// IANA timezone helpers (formatters are cached per zone; results must not mix)
// ---------------------------------------------------------------------------

describe("timezone helpers", () => {
  const instant = new Date("2024-07-01T12:00:00Z");

  it("reports each zone's own offset, also when zones alternate", () => {
    expect(getTimezoneOffsetMinutes("Asia/Ho_Chi_Minh", instant)).toBe(420);
    expect(getTimezoneOffsetMinutes("America/New_York", instant)).toBe(-240);
    expect(getTimezoneOffsetMinutes("Asia/Ho_Chi_Minh", instant)).toBe(420);
    expect(getTimezoneOffsetMinutes("America/New_York", new Date("2024-01-01T12:00:00Z"))).toBe(-300);
  });

  it("falls back to UTC for an unknown zone, every time", () => {
    expect(getTimezoneOffsetMinutes("Not/AZone", instant)).toBe(0);
    expect(getTimezoneOffsetMinutes("Not/AZone", instant)).toBe(0);
  });

  it("round-trips wall-clock time through a zone", () => {
    expect(wallClockToISO("2024-07-01T09:30", "Asia/Ho_Chi_Minh")).toBe("2024-07-01T09:30:00+07:00");
    expect(isoToWallClock("2024-07-01T02:30:00Z", "Asia/Ho_Chi_Minh")).toBe("2024-07-01T09:30");
    expect(isoToWallClock("2024-07-01T02:30:00Z", "America/New_York")).toBe("2024-06-30T22:30");
  });

  it("formats an instant in a zone as month, day and time, with the year when it is not this one", () => {
    const now = new Date("2024-03-01T00:00:00Z");
    expect(formatInTimezone("2024-07-01T02:30:00Z", "Asia/Ho_Chi_Minh", now)).toBe("Jul 1, 09:30");
    expect(formatInTimezone("2024-07-01T02:30:00Z", "UTC", now)).toBe("Jul 1, 02:30");
    expect(formatInTimezone("2024-07-01T02:30:00Z", "America/New_York", now)).toBe("Jun 30, 22:30");
    expect(formatInTimezone("2023-12-31T23:30:00Z", "UTC", now)).toBe("Dec 31, 2023, 23:30");
  });
});

describe("formatCommitTime", () => {
  it("reads like every other date and time", () => {
    const date = new Date(2024, 5, 30, 9, 5);
    expect(formatCommitTime(date.getTime() / 1000, new Date(2024, 6, 2, 12, 0))).toBe("Jun 30, 09:05");
  });
});

describe("formatTime matches toLocaleTimeString", () => {
  it("renders the same string as the per-call locale call", () => {
    const date = new Date(2024, 0, 15, 7, 3, 0);
    expect(formatTime(date)).toBe(date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: false }));
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

  it("names the month for older dates this year: 'Oct 29, 14:32'", () => {
    const now = new Date(2024, 9, 31, 12, 0);
    expect(formatRelativeDate(new Date(2024, 9, 29, 14, 32).toISOString(), now)).toBe("Oct 29, 14:32");
    expect(formatRelativeDate(new Date(2024, 2, 5, 8, 3).toISOString(), now)).toBe("Mar 5, 08:03");
  });

  it("adds the year only when it is not this one", () => {
    const now = new Date(2024, 9, 31, 12, 0);
    expect(formatRelativeDate(new Date(2023, 2, 5, 8, 3).toISOString(), now)).toBe("Mar 5, 2023, 08:03");
  });

  it("reads a future date the same way", () => {
    const now = new Date(2024, 9, 1, 12, 0);
    expect(formatRelativeDate(new Date(2024, 9, 29, 14, 32).toISOString(), now)).toBe("Oct 29, 14:32");
  });
});

// ---------------------------------------------------------------------------
// formatFullDateTime
// ---------------------------------------------------------------------------

describe("formatFullDateTime", () => {
  it("reads like formatRelativeDate, to the second", () => {
    const now = new Date(2024, 0, 20, 12, 0);
    expect(formatFullDateTime(new Date(2024, 0, 15, 9, 5, 3), now)).toBe("Jan 15, 09:05:03");
    expect(formatFullDateTime(new Date(2023, 2, 5, 8, 3, 0), now)).toBe("Mar 5, 2023, 08:03:00");
    expect(formatFullDateTime(new Date(2024, 0, 20, 7, 1, 9), now)).toBe("Today 07:01:09");
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

describe("finalAnswerBlocks", () => {
  it("is the prose after the turn's last tool call, blank and sentinel-only blocks left out", () => {
    const turn = [
      { id: "t1", type: "text", content: "Let me look." },
      { id: "x1", type: "tool", content: "" },
      { id: "h1", type: "thinking", content: "hmm" },
      { id: "t2", type: "text", content: "  " },
      { id: "t3", type: "text", content: "<sleep>" },
      { id: "t4", type: "text", content: "Found it." },
    ] as import("@/api/types").ContentBlock[];
    expect(finalAnswerBlocks(turn).map((b) => b.id)).toEqual(["t4"]);
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

// ─────────────────────────────────────────────────────────────────────────────
// formatCompactUpcoming
// ─────────────────────────────────────────────────────────────────────────────

describe("formatCompactUpcoming", () => {
  // Local times, so the expectations hold in any test timezone.
  const now = new Date(2026, 2, 10, 12, 0);
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 2, day, hour, minute).toISOString();

  it("shows the time for later today, the weekday within a week, then the date", () => {
    expect(formatCompactUpcoming(at(10, 18, 5), now)).toBe("18:05");
    expect(formatCompactUpcoming(at(11, 9), now)).toBe("Wed 09:00");
    expect(formatCompactUpcoming(at(20, 9), now)).toBe("Mar 20");
    expect(formatCompactUpcoming(new Date(2027, 0, 4, 9).toISOString(), now)).toBe("Jan 4, 2027");
  });

  it("reads due once the time has passed, and empty for missing input", () => {
    expect(formatCompactUpcoming(at(10, 11), now)).toBe("due");
    expect(formatCompactUpcoming(null, now)).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatCompactRelative
// ─────────────────────────────────────────────────────────────────────────────

describe("formatCompactRelative", () => {
  const now = new Date("2026-03-10T12:00:00Z");

  it("returns an empty string for missing or invalid input", () => {
    expect(formatCompactRelative(null, now)).toBe("");
    expect(formatCompactRelative(undefined, now)).toBe("");
    expect(formatCompactRelative("not-a-date", now)).toBe("");
  });

  it("steps through now / minutes / hours / days", () => {
    expect(formatCompactRelative("2026-03-10T11:59:40Z", now)).toBe("now");
    expect(formatCompactRelative("2026-03-10T12:05:00Z", now)).toBe("now");
    expect(formatCompactRelative("2026-03-10T11:55:00Z", now)).toBe("5m");
    expect(formatCompactRelative("2026-03-10T09:00:00Z", now)).toBe("3h");
    expect(formatCompactRelative("2026-03-08T12:00:00Z", now)).toBe("2d");
  });

  it("names the month past a week, and the year only when it is not this one", () => {
    const local = new Date(2026, 2, 10, 12, 0);
    expect(formatCompactRelative(new Date(2026, 1, 20, 12, 0).toISOString(), local)).toBe("Feb 20");
    expect(formatCompactRelative(new Date(2025, 9, 29, 12, 0).toISOString(), local)).toBe("Oct 29, 2025");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatCompactDate
// ─────────────────────────────────────────────────────────────────────────────

describe("formatCompactDate", () => {
  const now = new Date(2026, 2, 10, 12, 0);

  it("names the month and day in English, whatever the system locale", () => {
    expect(formatCompactDate(new Date(2026, 9, 29), now)).toBe("Oct 29");
    expect(formatCompactDate(new Date(2026, 0, 1), now)).toBe("Jan 1");
  });

  it("adds the year for another year", () => {
    expect(formatCompactDate(new Date(2025, 11, 31), now)).toBe("Dec 31, 2025");
  });
});
