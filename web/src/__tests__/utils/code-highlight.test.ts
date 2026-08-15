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
      ["jsx", "const A = () => <b>hi</b>", "tag:b"],
      ["yaml", "key: value", "property:key"],
      ["json", '{"a": 1}', "number:1"],
      ["env", "TOKEN=abc", "property:TOKEN"],
      ["css", "a.btn { color: red; }", "property:color"],
      ["dockerfile", "FROM node:20", "keyword:FROM"],
      ["html", '<div class="x">hi</div>', "tag:div"],
      ["http", "GET /api/v1 HTTP/1.1", "keyword:GET"],
      ["sql", "SELECT id FROM turns", "keyword:SELECT"],
      ["toml", "[server]\nport = 8080", "number:8080"],
    ];

    for (const [lang, code, expected] of cases) {
      expect(classed(code, lang)).toContain(expected);
    }
  });

  it("classifies diff hunks as inserted and deleted", () => {
    const out = classed("--- a\n+++ b\n-old line\n+new line", "diff");

    expect(out).toContain("deleted:-old line");
    expect(out).toContain("inserted:+new line");
  });

  it("resolves xml fences to the html grammar", () => {
    expect(classed('<div class="x">hi</div>', "xml")).toContain("tag:div");
  });
});

describe("tokenizeCode — go", () => {
  it("classifies keywords, types, literals and numbers", () => {
    const out = classed("var count int = 42\nif ok { return nil }", "go");

    expect(out).toContain("keyword:var");
    expect(out).toContain("type:int");
    expect(out).toContain("number:42");
    expect(out).toContain("literal:nil");
  });

  it("classifies plain functions and methods by name", () => {
    const out = classed("func greet(n string) {}\nfunc (h *Handler) Handle() {}", "go");

    expect(out).toContain("function:greet");
    expect(out).toContain("function:Handle");
  });

  it("classifies raw string literals", () => {
    const out = classed("q := `SELECT 1`", "go");

    expect(out).toContain("string:`SELECT 1`");
    // `SELECT` sits inside the string, so no keyword may be claimed there.
    expect(out.some((entry) => entry.startsWith("keyword:"))).toBe(false);
  });

  it("resolves the golang alias", () => {
    expect(classed("package main", "golang")).toContain("keyword:package");
  });
});

describe("tokenizeCode — java", () => {
  it("classifies keywords, types, annotations and literals", () => {
    const out = classed("@Override\npublic String name() { return null; }", "java");

    expect(out).toContain("meta:@Override");
    expect(out).toContain("keyword:public");
    expect(out).toContain("type:String");
    expect(out).toContain("literal:null");
  });

  it("classifies a method name but not a control-flow keyword", () => {
    const out = classed("if (ready) { compute(1); }", "java");

    expect(out).toContain("keyword:if");
    expect(out).toContain("function:compute");
    expect(out).not.toContain("function:if");
  });
});

describe("tokenizeCode — c and cpp", () => {
  it("classifies preprocessor directives as meta", () => {
    const out = classed('#include <stdio.h>\nint main(void) { return 0; }', "c");

    expect(out).toContain("meta:#include <stdio.h>");
    expect(out).toContain("type:int");
    expect(out).toContain("function:main");
  });

  it("classifies cpp-only keywords the c grammar does not know", () => {
    const out = classed("class Server { public: void run(); };", "cpp");

    expect(out).toContain("keyword:class");
    expect(out).toContain("keyword:public");
  });

  it("resolves the c++ and header aliases", () => {
    expect(classed("class A {};", "c++")).toContain("keyword:class");
    expect(classed("class A {};", "hpp")).toContain("keyword:class");
    expect(classed("int x;", "h")).toContain("type:int");
  });

  it("keeps keywords inside comments and strings unclassified", () => {
    const out = classed('// return this\nconst char *s = "return this";', "c");

    expect(out).toContain("comment:// return this");
    expect(out).toContain('string:"return this"');
    expect(out.filter((entry) => entry === "keyword:return")).toHaveLength(0);
  });
});

describe("tokenizeCode — ruby", () => {
  it("classifies keywords, symbols, constants and instance variables", () => {
    const out = classed("class Retry\n  def run(name)\n    @name = :fast\n  end\nend", "ruby");

    expect(out).toContain("keyword:class");
    expect(out).toContain("type:Retry");
    expect(out).toContain("function:run");
    expect(out).toContain("variable:@name");
    expect(out).toContain("attr::fast");
  });

  it("classifies bang and predicate method names", () => {
    const out = classed("def valid?\nend\ndef save!\nend", "ruby");

    expect(out).toContain("function:valid?");
    expect(out).toContain("function:save!");
  });

  it("resolves the rb alias", () => {
    expect(classed("nil", "rb")).toContain("literal:nil");
  });

  it("treats a scope resolution as a constant, not a symbol", () => {
    const out = classed("ActiveRecord::Base.find(1)", "ruby");

    expect(out).toContain("type:ActiveRecord");
    expect(out).toContain("type:Base");
    expect(out).not.toContain("attr::Base");
  });

  it("still classifies symbols in an array literal", () => {
    const out = classed("[:a, :b]", "ruby");

    expect(out).toContain("attr::a");
    expect(out).toContain("attr::b");
  });
});

describe("tokenizeCode — graphql", () => {
  it("classifies operations, type names and field arguments", () => {
    const out = classed("query GetTurn($id: ID!) {\n  turn(id: $id) { body }\n}", "graphql");

    expect(out).toContain("keyword:query");
    expect(out).toContain("type:ID");
    expect(out).toContain("variable:$id");
  });

  it("resolves the gql alias", () => {
    expect(classed("type Turn { id: ID }", "gql")).toContain("keyword:type");
  });
});

describe("tokenizeCode — makefile", () => {
  it("classifies targets, assignments, variables and directives", () => {
    const out = classed("CC := gcc\n\nbuild: deps\n\t$(CC) -o out main.c", "makefile");

    expect(out).toContain("attr:CC");
    expect(out).toContain("selector:build:");
    expect(out).toContain("variable:$(CC)");
  });

  it("classifies conditional directives", () => {
    const out = classed("ifeq ($(OS),Darwin)\nendif", "makefile");

    expect(out).toContain("keyword:ifeq");
    expect(out).toContain("keyword:endif");
  });

  it("resolves the make alias", () => {
    expect(classed("# note", "make")).toContain("comment:# note");
  });
});
