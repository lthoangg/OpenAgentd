import { describe, expect, it } from "bun:test";

import { tokenizeCode } from "@/utils/code-highlight";

/** Collapse tokens to `className:value` pairs for readable assertions. */
function classed(code: string, lang: string): Array<string> {
  return tokenizeCode(code, lang)
    .filter((token) => token.className)
    .map((token) => `${token.className}:${token.value}`);
}

describe("tokenizeCode", () => {
  it("round-trips the source exactly, whatever the grammar", () => {
    const code = "fn main() {\n\tlet x = 1; // note\n}";
    for (const lang of ["rust", "ini", "csv", "python", "unknown-language"]) {
      expect(tokenizeCode(code, lang).map((t) => t.value).join("")).toBe(code);
    }
  });

  it("returns a single unclassed token for an unregistered grammar", () => {
    const tokens = tokenizeCode("++[->+<]", "brainfuck");

    expect(tokens).toEqual([{ value: "++[->+<]" }]);
  });
});

describe("tokenizeCode — rust", () => {
  it("classifies keywords, types, literals and numbers", () => {
    const out = classed("let count: u32 = 42;", "rust");

    expect(out).toContain("keyword:let");
    expect(out).toContain("type:u32");
    expect(out).toContain("number:42");
  });

  it("classifies function definitions and attributes", () => {
    const out = classed("#[derive(Debug)]\nfn parse(input: &str) -> bool {}", "rust");

    expect(out).toContain("meta:#[derive(Debug)]");
    expect(out).toContain("keyword:fn");
    expect(out).toContain("function:parse");
  });

  it("keeps comment and string content out of the keyword rules", () => {
    const out = classed('// let me be a comment\nlet s = "let me be a string";', "rust");

    expect(out).toContain("comment:// let me be a comment");
    expect(out).toContain('string:"let me be a string"');
    // Only the real `let` outside the comment/string is a keyword.
    expect(out.filter((entry) => entry === "keyword:let")).toHaveLength(1);
  });

  it("resolves the rs alias", () => {
    expect(classed("let x = 1;", "rs")).toContain("keyword:let");
  });
});

describe("tokenizeCode — ini", () => {
  it("classifies sections, keys and values", () => {
    const out = classed("[server]\nport = 8080\ndebug = true", "ini");

    expect(out).toContain("selector:[server]");
    expect(out).toContain("attr:port");
    expect(out).toContain("number:8080");
    expect(out).toContain("literal:true");
  });

  it("treats both ; and # as comments", () => {
    const out = classed("; semicolon\n# hash\nkey = 1", "ini");

    expect(out).toContain("comment:; semicolon");
    expect(out).toContain("comment:# hash");
  });
});

describe("tokenizeCode — csv", () => {
  it("marks the header row and classifies numeric cells", () => {
    const out = classed("name,count\nwidgets,42", "csv");

    expect(out).toContain("heading:name,count");
    expect(out).toContain("number:42");
  });

  it("classifies quoted cells as strings", () => {
    const out = classed('a,b\n"has, comma",2', "csv");

    expect(out).toContain('string:"has, comma"');
  });
});

describe("tokenizeCode — bundled grammars", () => {
  it("covers every language the chat renderer advertises", () => {
    const cases: Array<[string, string, string]> = [
      ["shell", "echo hi", "command:echo"],
      ["python", "import os", "keyword:import"],
      ["ts", "const x = 1", "keyword:const"],
      ["tsx", "const x = 1", "keyword:const"],
      ["js", "const x = 1", "keyword:const"],
      ["yaml", "key: value", "property:key"],
      ["json", '{"a": 1}', "number:1"],
      ["env", "TOKEN=abc", "property:TOKEN"],
    ];

    for (const [lang, code, expected] of cases) {
      expect(classed(code, lang)).toContain(expected);
    }
  });
});
