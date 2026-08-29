/**
 * Attachment strip state + handlers for InputComposer — file selection, paste,
 * and drag-and-drop.
 *
 * Kept in a separate module (not a `.tsx` component) so InputComposer.tsx's
 * render tree stays focused on layout/markup; this hook owns all the
 * `files` state transitions and DOM event wiring around them.
 */
import { useCallback, useMemo, useRef, useState, useEffect } from 'react'
import type { AgentCapabilities } from '@/api/types'
import {
  MAX_TOTAL_ATTACHMENT_BYTES,
  filesFromDataTransfer,
  isFileTypeAllowed,
  splitFilesByBudget,
} from './InputComposer.files'
import { useToastStore } from '@/stores/useToastStore'
import { formatBytes } from '@/utils/format'

export interface UseInputComposerAttachmentsOptions {
  capabilities?: AgentCapabilities
}

export function useInputComposerAttachments({ capabilities }: UseInputComposerAttachmentsOptions) {
  const [files, setFiles] = useState<File[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pushToast = useToastStore((s) => s.push)

  // Create blob URLs for files — memoized to avoid recreating on every render
  const blobUrls = useMemo(() => {
    const urls = new Map<number, string>()
    files.forEach((file, idx) => {
      urls.set(idx, URL.createObjectURL(file))
    })
    return urls
  }, [files])

  // Revoke blob URLs when files change or on unmount
  useEffect(() => {
    return () => {
      blobUrls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [blobUrls])

  const removeFile = useCallback((index: number) => {
    // The blobUrls cleanup effect revokes URLs for any file that leaves the
    // map, so we only need to update state here — no manual revocation needed.
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }, [])

  /**
   * The single funnel for every attach path — drop, paste, and file picker.
   * Enforces the request-size budget here rather than at submit time, because
   * by then the composer has already been cleared and a rejected upload takes
   * the message down with it.
   */
  const addFiles = useCallback((nextFiles: File[]) => {
    const allowed = nextFiles.filter((file) => isFileTypeAllowed(file, capabilities))
    if (allowed.length === 0) return

    const { accepted, rejected } = splitFilesByBudget(files, allowed)

    if (rejected.length > 0) {
      pushToast({
        tone: 'error',
        title: rejected.length === 1 ? 'File too large to attach' : 'Files too large to attach',
        description:
          `${rejected.map((f) => f.name).join(', ')} — a message can carry ` +
          `${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)} of attachments in total.`,
      })
    }

    if (accepted.length === 0) return
    setFiles((prev) => [...prev, ...accepted])
  }, [capabilities, files, pushToast])

  const addFile = useCallback((file: File) => {
    addFiles([file])
  }, [addFiles])

  /** Extract file items from a paste event's clipboard data, filtered by type. */
  const extractPastedFiles = useCallback((items: DataTransferItemList): File[] => {
    const pastedFiles: File[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file && isFileTypeAllowed(file, capabilities)) {
          pastedFiles.push(file)
        }
      }
    }
    return pastedFiles
  }, [capabilities])

  // The drag overlay is owned by the surrounding chat column
  // (AgentChatView/useDragDrop), which needs these events to keep bubbling —
  // these handlers only mark the pill as a valid drop target.
  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
  }, [])

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    const dropped = filesFromDataTransfer(e.dataTransfer)
    if (dropped.length === 0) return
    // ``addFiles`` filters and commits in one state update — a per-file loop
    // queued one update per dropped file for no benefit.
    addFiles(dropped)
  }, [addFiles])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.currentTarget.files
    if (!selectedFiles) return
    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i]
      if (isFileTypeAllowed(file, capabilities)) {
        addFile(file)
      }
    }
    e.currentTarget.value = ''
  }, [addFile, capabilities])

  return {
    files,
    setFiles,
    fileInputRef,
    blobUrls,
    addFile,
    removeFile,
    addFiles,
    extractPastedFiles,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    handleFileSelect,
  }
}
