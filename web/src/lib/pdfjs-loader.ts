/**
 * Shared pdf.js loader — dynamically imports `pdfjs-dist` and wires up its
 * worker exactly once per page load, no matter how many PDF previews are on
 * screen (`PdfThumbnail`, `PdfDocumentViewer`, …).
 *
 * Kept as a dynamic import (not a static one) so the ~300kB dependency never
 * lands in the main bundle for sessions that never preview a PDF.
 */

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null

export function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ])
      .then(([pdfjs, workerUrl]) => {
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.default
        return pdfjs
      })
      .catch((err) => {
        pdfjsPromise = null
        throw err
      })
  }
  return pdfjsPromise
}
