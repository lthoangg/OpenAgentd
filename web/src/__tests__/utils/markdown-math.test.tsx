import { describe, it, expect } from "bun:test";
import { render } from "@testing-library/react";
import { MarkdownBlock } from "@/utils/markdown";

describe("MarkdownBlock math rendering", () => {
  describe("inline math", () => {
    it("renders $\\rightarrow$ as inline KaTeX math", () => {
      const { container } = render(<MarkdownBlock content="Arrow: $\\rightarrow$" />);
      const math = container.querySelector(".oa-math-inline");
      expect(math).not.toBeNull();
      expect(math?.querySelector(".katex")).not.toBeNull();
      expect(math?.textContent).toContain("→");
    });

    it("renders formula $x^2 + y^2 = z^2$ as inline KaTeX math", () => {
      const { container } = render(<MarkdownBlock content="Equation $x^2 + y^2 = z^2$ holds." />);
      const math = container.querySelector(".oa-math-inline");
      expect(math).not.toBeNull();
      expect(math?.querySelector(".katex")).not.toBeNull();
    });

    it("renders \\(a + b\\) as inline KaTeX math", () => {
      const { container } = render(<MarkdownBlock content="Sum: \\(a + b\\)" />);
      const math = container.querySelector(".oa-math-inline");
      expect(math).not.toBeNull();
      expect(math?.querySelector(".katex")).not.toBeNull();
    });

    it("renders multiple inline math expressions in one sentence", () => {
      const { container } = render(
        <MarkdownBlock content="From $x$ to $y$ via $\\rightarrow$." />,
      );
      const mathElements = container.querySelectorAll(".oa-math-inline");
      expect(mathElements.length).toBe(3);
    });

    it("does not render currency amounts like $50 and $100 as math", () => {
      const { container } = render(
        <MarkdownBlock content="Prices range from $50 and $100 for items." />,
      );
      expect(container.querySelector(".oa-math-inline")).toBeNull();
      expect(container.querySelector(".katex")).toBeNull();
      expect(container.textContent).toContain("$50 and $100");
    });

    it("does not render price range $50 to $100 as math", () => {
      const { container } = render(
        <MarkdownBlock content="It costs between $50 to $100." />,
      );
      expect(container.querySelector(".oa-math-inline")).toBeNull();
      expect(container.querySelector(".katex")).toBeNull();
      expect(container.textContent).toContain("$50 to $100");
    });

    it("does not render space-padded dollar expressions as math", () => {
      const { container } = render(
        <MarkdownBlock content="Not math: $ 50$ or $50 $." />,
      );
      expect(container.querySelector(".oa-math-inline")).toBeNull();
      expect(container.querySelector(".katex")).toBeNull();
    });

    it("does not render escaped dollar signs as math", () => {
      const { container } = render(
        <MarkdownBlock content="Cost is \\$50 total." />,
      );
      expect(container.querySelector(".oa-math-inline")).toBeNull();
      expect(container.querySelector(".katex")).toBeNull();
      expect(container.textContent).toContain("$50");
    });

    it("leaves inline code containing dollar signs untouched", () => {
      const { container } = render(
        <MarkdownBlock content={'Run `$\\rightarrow$` command.'} />,
      );
      expect(container.querySelector(".oa-math-inline")).toBeNull();
      expect(container.querySelector(".katex")).toBeNull();
      const code = container.querySelector("code");
      expect(code?.textContent).toBe("$\\rightarrow$");
    });
  });

  describe("display and block math", () => {
    it("renders single-line $$...$$ as block display math", () => {
      const { container } = render(<MarkdownBlock content="$$E = mc^2$$" />);
      const block = container.querySelector(".oa-math-block");
      expect(block).not.toBeNull();
      expect(block?.querySelector(".katex-display")).not.toBeNull();
    });

    it("renders multi-line $$...$$ as block display math", () => {
      const content = ["$$", "\\int_0^1 x^2 dx = \\frac{1}{3}", "$$"].join("\n");
      const { container } = render(<MarkdownBlock content={content} />);
      const block = container.querySelector(".oa-math-block");
      expect(block).not.toBeNull();
      expect(block?.querySelector(".katex-display")).not.toBeNull();
    });

    it("renders multi-line \\[...\\] as block display math", () => {
      const content = ["\\[", "\\int_0^1 x^2 dx = \\frac{1}{3}", "\\]"].join("\n");
      const { container } = render(<MarkdownBlock content={content} />);
      const block = container.querySelector(".oa-math-block");
      expect(block).not.toBeNull();
      expect(block?.querySelector(".katex-display")).not.toBeNull();
    });

    it("renders ```math fenced code blocks as block display math", () => {
      const content = ["```math", "\\sum_{i=1}^n i = \\frac{n(n+1)}{2}", "```"].join("\n");
      const { container } = render(<MarkdownBlock content={content} />);
      const block = container.querySelector(".oa-math-block");
      expect(block).not.toBeNull();
      expect(block?.querySelector(".katex-display")).not.toBeNull();
    });

    it("renders ```katex fenced code blocks as block display math", () => {
      const content = ["```katex", "\\sum_{i=1}^n i = \\frac{n(n+1)}{2}", "```"].join("\n");
      const { container } = render(<MarkdownBlock content={content} />);
      const block = container.querySelector(".oa-math-block");
      expect(block).not.toBeNull();
      expect(block?.querySelector(".katex-display")).not.toBeNull();
    });
  });

  describe("math in structured markdown", () => {
    it("renders math inside table cells", () => {
      const content = [
        "| Symbol | Meaning |",
        "| --- | --- |",
        "| $\\rightarrow$ | Implies |",
        "| $\\alpha$ | Alpha |",
      ].join("\n");
      const { container } = render(<MarkdownBlock content={content} />);
      const mathElements = container.querySelectorAll(".oa-math-inline");
      expect(mathElements.length).toBe(2);
    });

    it("renders math inside list items", () => {
      const content = [
        "- Step 1: $x = 1$",
        "- Step 2: $y = \\rightarrow$",
      ].join("\n");
      const { container } = render(<MarkdownBlock content={content} />);
      const mathElements = container.querySelectorAll(".oa-math-inline");
      expect(mathElements.length).toBe(2);
    });

    it("renders math inside headings", () => {
      const { container } = render(<MarkdownBlock content="# Theorem for $n = 2$" />);
      const math = container.querySelector("h1 .oa-math-inline");
      expect(math).not.toBeNull();
    });

    it("renders math inside blockquotes", () => {
      const { container } = render(<MarkdownBlock content="> Note: $\\rightarrow$ is used here." />);
      const math = container.querySelector("blockquote .oa-math-inline");
      expect(math).not.toBeNull();
    });
  });

  describe("error resiliency", () => {
    it("does not crash on invalid LaTeX syntax", () => {
      const { container } = render(<MarkdownBlock content="$\\frac{unclosed$" />);
      expect(container).toBeTruthy();
    });
  });
});
