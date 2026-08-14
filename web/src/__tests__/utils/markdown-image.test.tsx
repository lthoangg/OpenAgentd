import { describe, it, expect, afterEach } from "bun:test";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MarkdownBlock, resolveImageSrc, extractFileName } from "@/utils/markdown";

afterEach(() => {
  cleanup();
  delete window.__OAD_API_BASE_URL__;
  delete window.__OAD_TOKEN__;
});

describe("extractFileName", () => {
  it("extracts filename from simple path", () => {
    expect(extractFileName("chart.png")).toBe("chart.png");
  });

  it("extracts filename from nested path", () => {
    expect(extractFileName("out/plots/chart.png")).toBe("chart.png");
  });

  it("extracts filename from URL with query string and hash", () => {
    expect(extractFileName("https://example.com/images/demo.jpg?v=123#ref")).toBe("demo.jpg");
  });

  it("decodes URL-encoded filenames", () => {
    expect(extractFileName("my%20chart%201.png")).toBe("my chart 1.png");
  });

  it("returns null for data URIs and blob URIs", () => {
    expect(extractFileName("data:image/png;base64,abc")).toBeNull();
    expect(extractFileName("blob:http://localhost/uuid")).toBeNull();
  });
});

describe("resolveImageSrc", () => {
  const sid = "019d9777-ebc9-770e-8b8c-698c9baa5d50";

  it("passes http(s) URLs through unchanged", () => {
    expect(resolveImageSrc("https://example.com/img.png", sid)).toBe(
      "https://example.com/img.png",
    );
    expect(resolveImageSrc("http://example.com/img.png", sid)).toBe(
      "http://example.com/img.png",
    );
  });

  it("passes protocol-relative URLs through unchanged", () => {
    expect(resolveImageSrc("//cdn.example.com/a.png", sid)).toBe(
      "//cdn.example.com/a.png",
    );
  });

  it("passes data: URIs through unchanged", () => {
    const dataUri = "data:image/png;base64,iVBORw0KG...";
    expect(resolveImageSrc(dataUri, sid)).toBe(dataUri);
  });

  it("passes blob: URIs through unchanged", () => {
    const blobUri = "blob:http://localhost:5173/abc-123";
    expect(resolveImageSrc(blobUri, sid)).toBe(blobUri);
  });

  it("passes existing /api/ URLs through unchanged (no double-prefix)", () => {
    const api = `/api/team/${sid}/media/foo.png`;
    expect(resolveImageSrc(api, sid)).toBe(api);
  });

  it("adds the desktop token query param to existing /api/ URLs", () => {
    window.__OAD_TOKEN__ = "secret";
    expect(resolveImageSrc(`/api/team/${sid}/media/foo.png`, sid)).toBe(
      `/api/team/${sid}/media/foo.png?_token=secret`,
    );
  });

  it("rewrites existing /api/ URLs when a custom API base URL is configured", async () => {
    const { setApiBaseUrl } = await import("@/api/base-url");
    setApiBaseUrl("http://127.0.0.1:4082");

    expect(resolveImageSrc(`/api/team/${sid}/media/foo.png`, sid)).toBe(
      `http://127.0.0.1:4082/api/team/${sid}/media/foo.png`,
    );
  });

  it("rewrites bare relative paths to the media proxy", () => {
    expect(resolveImageSrc("chart.png", sid)).toBe(
      `/api/team/${sid}/media/chart.png`,
    );
  });

  it("adds the desktop token query param to rewritten media proxy URLs", () => {
    window.__OAD_TOKEN__ = "secret";
    expect(resolveImageSrc("chart.png", sid)).toBe(
      `/api/team/${sid}/media/chart.png?_token=secret`,
    );
  });

  it("rewrites nested subpaths", () => {
    expect(resolveImageSrc("output/chart.png", sid)).toBe(
      `/api/team/${sid}/media/output/chart.png`,
    );
  });

  it("strips leading ./ from relative paths", () => {
    expect(resolveImageSrc("./chart.png", sid)).toBe(
      `/api/team/${sid}/media/chart.png`,
    );
  });

  it("strips leading slashes from bare paths", () => {
    // A leading slash would produce ``/api/team/{sid}/media//foo.png`` — strip.
    expect(resolveImageSrc("/chart.png", sid)).toBe(
      `/api/team/${sid}/media/chart.png`,
    );
  });

  it("URL-encodes the session id", () => {
    // Defensive — real session ids are UUIDs with no reserved chars, but
    // the implementation should still encode to protect against mistakes.
    const weird = "a/b";
    expect(resolveImageSrc("foo.png", weird)).toBe(
      `/api/team/${encodeURIComponent(weird)}/media/foo.png`,
    );
  });

  it("passes bare paths through when no sessionId is provided", () => {
    expect(resolveImageSrc("chart.png", undefined)).toBe("chart.png");
  });

  it("returns undefined for undefined src", () => {
    expect(resolveImageSrc(undefined, sid)).toBe(undefined);
  });
});

describe("MarkdownBlock image rendering", () => {
  const sid = "019d9777-ebc9-770e-8b8c-698c9baa5d50";

  it("renders http(s) image src as-is", () => {
    render(
      <MarkdownBlock
        content="![cat](https://example.com/cat.png)"
        sessionId={sid}
      />,
    );
    const img = screen.getByRole("img", { name: /cat/i });
    expect(img).toHaveAttribute("src", "https://example.com/cat.png");
  });

  it("rewrites bare image path to media proxy when sessionId provided", () => {
    render(
      <MarkdownBlock content="![chart](chart.png)" sessionId={sid} />,
    );
    const img = screen.getByRole("img", { name: /chart/i });
    expect(img).toHaveAttribute("src", `/api/team/${sid}/media/chart.png`);
  });

  it("rewrites nested subpath", () => {
    render(
      <MarkdownBlock
        content="![report](out/report.png)"
        sessionId={sid}
      />,
    );
    const img = screen.getByRole("img", { name: /report/i });
    expect(img).toHaveAttribute(
      "src",
      `/api/team/${sid}/media/out/report.png`,
    );
  });

  it("falls back to raw src when no sessionId", () => {
    render(<MarkdownBlock content="![x](foo.png)" />);
    const img = screen.getByRole("img", { name: /x/i });
    expect(img).toHaveAttribute("src", "foo.png");
  });

  it("sets loading=lazy and decoding=async", () => {
    render(
      <MarkdownBlock content="![c](c.png)" sessionId={sid} />,
    );
    const img = screen.getByRole("img", { name: /c/i });
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("decoding", "async");
  });

  it("always sets alt (empty string if missing)", () => {
    render(
      <MarkdownBlock content="![](c.png)" sessionId={sid} />,
    );
    // Images with empty alt are still accessible but have role="presentation"
    // in some axe rules — getByRole may not find them. Use querySelector.
    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("alt")).toBe("");
  });

  it("uses cursor-zoom-in to signal click-to-open", () => {
    render(<MarkdownBlock content="![c](c.png)" sessionId={sid} />);
    const img = screen.getByRole("img", { name: /c/i });
    expect(img.className).toContain("cursor-zoom-in");
  });

  it("renders filename under image", () => {
    render(<MarkdownBlock content="![chart](out/report.png)" sessionId={sid} />);
    const caption = screen.getByText("report.png");
    expect(caption).not.toBeNull();
    expect(caption.className).toContain("text-center");
  });
});

describe("MarkdownBlock lightbox", () => {
  const sid = "019d9777-ebc9-770e-8b8c-698c9baa5d50";

  it("opens lightbox when the image is clicked", () => {
    render(<MarkdownBlock content="![chart](chart.png)" sessionId={sid} />);
    // No lightbox until click.
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("img", { name: /chart/i }));

    const dialog = screen.getByRole("dialog", { name: /image lightbox/i });
    expect(dialog).toBeInTheDocument();
    // Two images now: the inline one + the lightbox preview.
    const imgs = screen.getAllByRole("img", { name: /chart/i });
    expect(imgs.length).toBe(2);
  });

  it("closes the lightbox when the close button is clicked", () => {
    render(<MarkdownBlock content="![chart](chart.png)" sessionId={sid} />);
    fireEvent.click(screen.getByRole("img", { name: /chart/i }));

    fireEvent.click(
      screen.getByRole("button", { name: /close lightbox/i }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes the lightbox when the backdrop is clicked", () => {
    render(<MarkdownBlock content="![chart](chart.png)" sessionId={sid} />);
    fireEvent.click(screen.getByRole("img", { name: /chart/i }));

    const dialog = screen.getByRole("dialog", { name: /image lightbox/i });
    fireEvent.click(dialog);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes the lightbox when Escape is pressed", () => {
    render(<MarkdownBlock content="![chart](chart.png)" sessionId={sid} />);
    fireEvent.click(screen.getByRole("img", { name: /chart/i }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clicking the image inside the lightbox does not close it", () => {
    render(<MarkdownBlock content="![chart](chart.png)" sessionId={sid} />);
    fireEvent.click(screen.getByRole("img", { name: /chart/i }));

    // The lightbox preview is the second <img> with that alt.
    const imgs = screen.getAllByRole("img", { name: /chart/i });
    fireEvent.click(imgs[1]);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("each image gets an independent lightbox state", () => {
    render(
      <MarkdownBlock
        content={"![a](a.png)\n\n![b](b.png)"}
        sessionId={sid}
      />,
    );
    fireEvent.click(screen.getByRole("img", { name: /^a$/i }));
    const dialog = screen.getByRole("dialog");
    // The lightbox should display ``a.png`` — click on image ``b`` shouldn't
    // have opened. Close and repeat with b.
    const previewSrcA = dialog.querySelector("img")?.getAttribute("src");
    expect(previewSrcA).toContain("a.png");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("img", { name: /^b$/i }));
    const previewSrcB = screen
      .getByRole("dialog")
      .querySelector("img")
      ?.getAttribute("src");
    expect(previewSrcB).toContain("b.png");
  });
});

describe("MarkdownBlock broken image fallback", () => {
  const sid = "019d9777-ebc9-770e-8b8c-698c9baa5d50";

  it("renders an ImageOff placeholder when the image errors", () => {
    render(<MarkdownBlock content="![my chart](nope.png)" sessionId={sid} />);
    const img = screen.getByRole("img", { name: /my chart/i });
    fireEvent.error(img);

    // Image is gone; placeholder with the alt text replaces it.
    expect(screen.queryByRole("img", { name: /my chart/i })).toBeNull();
    expect(screen.getByText(/my chart/i)).toBeInTheDocument();
  });
});
