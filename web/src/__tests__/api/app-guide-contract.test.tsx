import { afterEach, describe, expect, it, mock } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

// Pele measures text with canvas, which the test DOM lacks.
mock.module("pele/lazy", () => ({
  mountAsync: async (element: HTMLElement, _source: string, options: { sanitize: (svg: string) => Node }) => {
    element.replaceChildren(options.sanitize('<svg xmlns="http://www.w3.org/2000/svg" class="pele"></svg>'))
    return { result: { svg: "" }, error: undefined, destroy() {} }
  },
}))

import { FileRefContext, type FileRefOpener } from "@/components/FileRefLink"
import { isShellLanguage, registerTerminalRunner } from "@/lib/terminal-run"
import { MarkdownBlock } from "@/utils/markdown"

// The backend appends `app_guide` to every lead agent's prompt: it tells the
// agent what this app does with a reply. Each test renders what one of its
// lines promises, so the guide and the app cannot drift apart. When one
// fails, change the app back or change the guide (builtin_prompts.json) in
// the same commit.
const guide = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../../../../appv3/crates/agent/data/builtin_prompts.json", import.meta.url)), "utf8"),
  ) as { app_guide: string }
).app_guide

/** The guide's bullet that starts with ``**title.**``. */
function rule(title: string): string {
  const line = guide.split("\n").find((l) => l.startsWith(`- **${title}.**`))
  if (!line) throw new Error(`the app guide has no "${title}" rule`)
  return line
}

let withdrawRunner: (() => void) | null = null

function renderReply(content: string, opener: Partial<FileRefOpener> = {}) {
  const value: FileRefOpener = { canOpen: () => true, open: () => {}, ...opener }
  return render(
    <FileRefContext.Provider value={value}>
      <MarkdownBlock content={content} sessionId="s1" />
    </FileRefContext.Provider>,
  )
}

afterEach(() => {
  cleanup()
  withdrawRunner?.()
  withdrawRunner = null
})

describe("app guide contract (appv3/crates/agent/data/builtin_prompts.json app_guide)", () => {
  it("has a rule for each thing checked here, and no others", () => {
    const titles = guide.split("\n").flatMap((l) => l.match(/^- \*\*(.+?)\.\*\*/)?.[1] ?? [])
    expect(titles).toEqual(["Commands the user must run", "Documents", "Local pages", "Images and video", "Diagrams and math", "Code"])
  })

  it("runs a block in every fence language the guide names for commands", () => {
    const commands = rule("Commands the user must run")
    expect(commands).toContain("Run in terminal button")
    // `shell` there is the agent's tool; it is a runnable language too.
    const languages = [...commands.matchAll(/`([a-z]+)`/g)].map((m) => m[1])
    expect(languages).toEqual(expect.arrayContaining(["bash", "sh", "zsh", "fish"]))
    const ran: string[] = []
    withdrawRunner = registerTerminalRunner((command) => ran.push(command))
    for (const language of languages) {
      expect(isShellLanguage(language)).toBe(true)
      renderReply(["```" + language, "gh auth login", "```"].join("\n"))
      fireEvent.click(screen.getByRole("button", { name: "Run in terminal" }))
      cleanup()
    }
    expect(ran).toEqual(languages.map(() => "gh auth login"))
  })

  it("opens the guide's own document link in the viewer", () => {
    const sample = rule("Documents").match(/\[[^\]]+\]\(([^)]+\.md)\)/)
    expect(sample).toBeTruthy()
    const opened: string[] = []
    renderReply(`See ${sample![0]}.`, { open: (ref) => opened.push(ref.path) })
    fireEvent.click(screen.getByRole("link"))
    expect(opened).toEqual([sample![1]])
  })

  it("opens a localhost link in Preview", () => {
    const pages = rule("Local pages")
    expect(pages).toContain("`localhost`")
    expect(pages).toContain("Preview tab")
    const previewed: unknown[] = []
    renderReply("Open [the app](http://localhost:5173/pricing).", { openPreview: (target) => previewed.push(target) })
    fireEvent.click(screen.getByRole("link"))
    expect(previewed).toEqual([{ kind: "url", url: "http://localhost:5173/pricing" }])
  })

  it("shows a workspace image and a workspace video inline", () => {
    expect(rule("Images and video")).toContain("`![alt](path)`")
    renderReply("![chart](out/chart.png)\n\n![clip](out/clip.mp4)")
    expect(document.querySelector("img")?.getAttribute("src")).toContain("/agent/s1/media/out/chart.png")
    expect(document.querySelector("video")?.getAttribute("src")).toContain("/agent/s1/media/out/clip.mp4")
  })

  it("draws a mermaid fence and renders both math forms", async () => {
    const visuals = rule("Diagrams and math")
    expect(visuals).toContain("`mermaid`")
    expect(visuals).toContain("`$…$`")
    expect(visuals).toContain("`$$…$$`")
    renderReply(["```mermaid", "flowchart LR", "  A --> B", "```", "", "Inline $x^2$ here.", "", "$$", "y = x^2", "$$"].join("\n"))
    await waitFor(() => expect(document.querySelector(".oa-diagram svg.pele")).toBeTruthy())
    expect(document.querySelector(".oa-math-inline")).toBeTruthy()
    expect(document.querySelector(".oa-math-block")).toBeTruthy()
  })

  it("gives a fenced block a Copy button and shows raw HTML as text", () => {
    const code = rule("Code")
    expect(code).toContain("Copy button")
    expect(code).toContain("Raw HTML in a reply is shown as text")
    renderReply(["```ts", "const x = 1", "```", "", "Use <b>bold</b> sparingly."].join("\n"))
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy()
    expect(document.querySelector("code .th-token")).toBeTruthy()
    expect(document.querySelector("b")).toBeNull()
    expect(document.body.textContent).toContain("<b>bold</b>")
  })
})
