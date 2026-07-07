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
import { isDraggingFiles } from './helpers'
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
      e.preventDefault()
      dragCounterRef.current = 0
      setIsDraggingFile(false)

      const droppedFiles = e.dataTransfer.files
      if (droppedFiles && droppedFiles.length > 0) {
        inputRef.current.addFiles(Array.from(droppedFiles))
      }
    }
  }, [inputRef])

  return { isDraggingFile, handleDragEnter, handleDragLeave, handleDragOver, handleDrop }
}
