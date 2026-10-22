/**
 * A ``read`` of an image reaches the transcript as its label only — the
 * pixels went to the model (``appv3-tools`` ``read::handle_image``):
 * ``[Image: docs/shot.png]`` or ``[Image: docs/shot.png (resized 2400×1600 → 2000×1333)]``.
 * The path is the tool's display path: workspace-relative inside it.
 */
const IMAGE_READ = /^\[Image: (.+?)(?: \(resized [^)]*\))?\]$/

export function parseImageRead(result: string | undefined): { path: string } | null {
  const match = result?.trim().match(IMAGE_READ)
  return match ? { path: match[1] } : null
}
