import { describe, it, expect, afterEach, mock } from "bun:test"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DownloadWorkspaceFileButton } from "@/components/WorkspaceFilesPanel"
import type { WorkspaceFileInfo } from "@/api/types"
import "@testing-library/jest-dom"

afterEach(() => {
  cleanup()
  delete window.__OAD_TOKEN__
})

const SID = "01900000-0000-7000-8000-000000000001"

const file: WorkspaceFileInfo = {
  path: "google_qr.png",
  name: "google_qr.png",
  size: 589,
  mtime: 1734556820.1,
  mime: "image/png",
}

describe("DownloadWorkspaceFileButton", () => {
  it("clicks a temporary download link with forced attachment URL", async () => {
    window.__OAD_TOKEN__ = "secret"
    const click = mock(() => {})
    const remove = mock(() => {})
    const originalCreateElement = document.createElement.bind(document)
    let anchor: HTMLAnchorElement | null = null

    document.createElement = ((tagName: string, options?: ElementCreationOptions) => {
      const element = originalCreateElement(tagName, options)
      if (tagName === "a") {
        anchor = element as HTMLAnchorElement
        Object.defineProperty(element, "click", { value: click })
        Object.defineProperty(element, "remove", { value: remove })
      }
      return element
    }) as typeof document.createElement

    try {
      render(
        <DownloadWorkspaceFileButton sessionId={SID} file={file}>
          Download
        </DownloadWorkspaceFileButton>,
      )

      await userEvent.click(screen.getByRole("button", { name: "Download" }))

      await waitFor(() => expect(click).toHaveBeenCalledTimes(1))
      expect(anchor).not.toBeNull()
      const capturedAnchor = anchor as unknown as HTMLAnchorElement
      expect(capturedAnchor.getAttribute("href")).toBe(
        `/api/team/${SID}/media/google_qr.png?download=1&_token=secret`,
      )
      expect(capturedAnchor.download).toBe("google_qr.png")
      expect(remove).toHaveBeenCalledTimes(1)
    } finally {
      document.createElement = originalCreateElement
    }
  })
})
