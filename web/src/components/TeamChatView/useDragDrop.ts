/**
 * useDragDrop — file drag-and-drop handling for the main chat column.
 *
 * Tracks a drag-enter/leave counter (so nested children entering/leaving
 * don't flicker the overlay) and forwards dropped files to the input bar
 * via ``inputRef``. Only reacts to drags carrying files (see
 * ``isDraggingFiles``) — text/link drags are ignored so native browser
 * drag behaviour (e.g. dragging selected text) still works.
 */
import { useCallback, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { isDraggingFiles } from '@/lib/is-dragging-files'
import { filesFromDataTransfer } from '../InputBar.files'
import type { InputBarHandle } from '../InputBar'

export interface UseDragDropResult {
  isDraggingFile: boolean
  handleDragEnter: (e: React.DragEvent) => void
  handleDragLeave: (e: React.DragEvent) => void
  handleDragOver: (e: React.DragEvent) => void
  handleDrop: (e: React.DragEvent) => void
}

export function useDragDrop(inputRef: RefObject<InputBarHandle | null>): UseDragDropResult {
  const [isDraggingFile, setIsDraggingFile] = useState(false)
  const dragCounterRef = useRef(0)

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!inputRef.current) return
    if (isDraggingFiles(e.dataTransfer)) {
      e.preventDefault()
      dragCounterRef.current++
      if (dragCounterRef.current === 1) {
        setIsDraggingFile(true)
      }
    }
  }, [inputRef])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!inputRef.current) return
    if (isDraggingFiles(e.dataTransfer)) {
      e.preventDefault()
      dragCounterRef.current--
      if (dragCounterRef.current === 0) {
        setIsDraggingFile(false)
      }
    }
  }, [inputRef])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!inputRef.current) return
    if (isDraggingFiles(e.dataTransfer)) {
      e.preventDefault()
    }
  }, [inputRef])

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!inputRef.current) return
    if (isDraggingFiles(e.dataTransfer)) {
      // The input bar sits inside this column and handles drops on itself
      // (InputBar.attachments.ts). Its handler calls ``preventDefault`` and
      // the event still bubbles up here, so without this guard a drop on the
      // pill would attach every file twice. We deliberately let it bubble
      // rather than ``stopPropagation`` at the source: the counter reset and
      // overlay teardown below have to run for *every* drop, including the
      // ones a child already consumed.
      const alreadyHandled = e.defaultPrevented

      e.preventDefault()
      dragCounterRef.current = 0
      setIsDraggingFile(false)

      if (alreadyHandled) return

      const droppedFiles = filesFromDataTransfer(e.dataTransfer)
      if (droppedFiles.length > 0) {
        inputRef.current.addFiles(droppedFiles)
      }
    }
  }, [inputRef])

  return { isDraggingFile, handleDragEnter, handleDragLeave, handleDragOver, handleDrop }
}
