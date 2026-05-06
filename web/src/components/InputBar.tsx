import { useRef, useState, useCallback, useImperativeHandle, forwardRef, useEffect, useMemo } from 'react'
import { ArrowUp, Loader2, Paperclip, Square } from 'lucide-react'
import { ImageAttachment } from './ImageAttachment'
import { FileCard } from './FileCard'
import { VoiceMicButton } from './VoiceMicButton'
import type { AgentCapabilities } from '@/api/types'

// ── Slash commands ──────────────────────────────────────────────────────────

export interface SlashCommand {
  id: string
  label: string
  description: string
}

interface InputBarProps {
  onSubmit: (message: string, files?: File[]) => void
  onStop?: () => void
  onSlashCommand?: (id: string) => void
  slashCommands?: SlashCommand[]
  isStreaming?: boolean
  disabled?: boolean
  placeholder?: string
  autoFocus?: boolean
  capabilities?: AgentCapabilities
  /**
   * When true, the component renders only the inner rounded pill (no
   * top border, no background row chrome). A parent wrapper is expected
   * to provide positioning, shadow, and backdrop. Used by
   * `FloatingInputBar` for the draggable variant.
   */
  floating?: boolean
  /**
   * When true, file previews render below the input container instead of
   * above it. Used by `FloatingInputBar` when the panel is near the top
   * edge of its bounds so previews stay visible.
   */
  filesBelow?: boolean
  /**
   * Optional render-prop for a drag handle rendered anchored to the top
   * edge of the input pill (not the outer wrapper). This keeps the handle
   * pinned to the input regardless of whether file previews are rendered
   * above or below. Used by `FloatingInputBar`.
   */
  renderDragHandle?: () => React.ReactNode
  /**
   * Whether voice input is enabled (from GET /api/speech/config).
   * When false the mic button is shown disabled with an explanatory tooltip.
   * When true the mic button records, transcribes, and appends to input.
   */
  voiceEnabled?: boolean
}

export interface InputBarHandle {
  focus: () => void
  setValue: (text: string) => void
}

const CHAR_WARN_THRESHOLD = 500

export const InputBar = forwardRef<InputBarHandle, InputBarProps>(function InputBar({
  onSubmit,
  onStop,
  onSlashCommand,
  slashCommands = [],
  isStreaming = false,
  disabled,
  placeholder = 'Message OpenAgentd…',
  autoFocus,
  capabilities,
  floating = false,
  filesBelow = false,
  renderDragHandle,
  voiceEnabled = false,
}, ref) {
  const [value, setValue] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [slashMenuIndex, setSlashMenuIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragCounterRef = useRef(0)

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

  const resize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    // max 6 rows ≈ 144px
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`
  }, [])

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    setValue: (text: string) => {
      setValue(text)
      // Trigger height recalculation after injecting text programmatically
      requestAnimationFrame(resize)
    },
  }))

  const submit = useCallback(() => {
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    onSubmit(trimmed, files.length > 0 ? files : undefined)
    setValue('')
    setFiles([])
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [value, disabled, onSubmit, files])

  const buildAcceptString = useCallback((): string => {
    const parts: string[] = [
      'text/plain', 'text/csv', 'text/tab-separated-values', 'text/markdown',
      'application/json', '.txt', '.csv', '.tsv', '.json', '.md',
    ]
    if (capabilities?.input.vision) parts.push('image/*')
    if (capabilities?.input.document_text) {
      parts.push('application/pdf', '.pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx')
    }
    if (capabilities?.input.audio) parts.push('audio/*')
    if (capabilities?.input.video) parts.push('video/*')
    return parts.join(',')
  }, [capabilities])

  const isFileTypeAllowed = useCallback((file: File): boolean => {
    const mimeType = file.type
    const name = file.name.toLowerCase()
    if (
      mimeType.startsWith('text/') || mimeType === 'application/json' ||
      name.endsWith('.txt') || name.endsWith('.csv') || name.endsWith('.tsv') ||
      name.endsWith('.json') || name.endsWith('.md')
    ) return true
    if (capabilities?.input.vision && mimeType.startsWith('image/')) return true
    if (capabilities?.input.document_text && (
      mimeType === 'application/pdf' ||
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      name.endsWith('.pdf') || name.endsWith('.docx')
    )) return true
    if (capabilities?.input.audio && mimeType.startsWith('audio/')) return true
    if (capabilities?.input.video && mimeType.startsWith('video/')) return true
    return false
  }, [capabilities])

  const addFile = useCallback((file: File) => {
    if (!isFileTypeAllowed(file)) return
    setFiles((prev) => [...prev, file])
  }, [isFileTypeAllowed])

  const removeFile = useCallback((index: number) => {
    const oldUrl = blobUrls.get(index)
    if (oldUrl) URL.revokeObjectURL(oldUrl)
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }, [blobUrls])

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file && isFileTypeAllowed(file)) {
          e.preventDefault()
          addFile(file)
        }
      }
    }
  }, [addFile, isFileTypeAllowed])

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragCounterRef.current++
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragCounterRef.current--
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
  }, [])

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragCounterRef.current = 0
    const droppedFiles = e.dataTransfer?.files
    if (!droppedFiles) return
    for (let i = 0; i < droppedFiles.length; i++) {
      const file = droppedFiles[i]
      if (isFileTypeAllowed(file)) {
        addFile(file)
      }
    }
  }, [addFile, isFileTypeAllowed])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.currentTarget.files
    if (!selectedFiles) return
    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i]
      if (isFileTypeAllowed(file)) {
        addFile(file)
      }
    }
    e.currentTarget.value = ''
  }, [addFile, isFileTypeAllowed])

  // ── Slash command filtering ────────────────────────────────────────────────

  const slashFilter = value.startsWith('/') && !value.includes(' ')
    ? value.slice(1).toLowerCase()
    : null
  const filteredSlashCommands = useMemo(() => {
    if (slashFilter === null || slashCommands.length === 0) return []
    return slashCommands.filter(
      (cmd) =>
        cmd.id.toLowerCase().includes(slashFilter) ||
        cmd.label.toLowerCase().includes(slashFilter)
    )
  }, [slashFilter, slashCommands])

  const slashMenuOpen = slashFilter !== null && filteredSlashCommands.length > 0

  // Clamp index to valid range (handles filter changes reducing the list)
  const clampedIndex = filteredSlashCommands.length > 0
    ? slashMenuIndex % filteredSlashCommands.length
    : 0

  const executeSlashCommand = useCallback((cmd: SlashCommand) => {
    setValue('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    onSlashCommand?.(cmd.id)
  }, [onSlashCommand])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Slash menu navigation
    if (slashMenuOpen && filteredSlashCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashMenuIndex((i) => (i + 1) % filteredSlashCommands.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashMenuIndex((i) => (i - 1 + filteredSlashCommands.length) % filteredSlashCommands.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        executeSlashCommand(filteredSlashCommands[clampedIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setValue('')
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value)
    setSlashMenuIndex(0)
    resize()
  }

  // ── Voice transcript insertion ────────────────────────────────────────────
  const handleVoiceTranscript = useCallback((transcript: string) => {
    setValue((prev) => {
      const trimmed = prev.trimEnd()
      return trimmed ? `${trimmed} ${transcript}` : transcript
    })
    requestAnimationFrame(resize)
  }, [resize])

  const hasText = value.trim().length > 0
  const canSend = hasText && !disabled
  const canStop = isStreaming && !disabled && onStop != null
  const charCount = value.length
  const showCharCount = charCount > CHAR_WARN_THRESHOLD

  // Single-row, horizontally scrollable list so many attachments don't push
  // the input off-screen vertically. `py-2`/`px-2` on the scroll container
  // give the remove buttons (positioned at `-top-2`/`-right-2` on each
  // card) room so they're not clipped by `overflow-x-auto` (which forces
  // the y-axis to clip as well). `-mx-2 -my-2` on the outer wrapper
  // neutralizes that padding so surrounding layout stays tight.
  const filePreviews = files.length > 0 ? (
    <div className={`${filesBelow ? 'mt-3' : 'mb-3'} -mx-2 -my-2`}>
      <div className="overflow-x-auto px-2 py-2">
        <div className="flex w-max flex-nowrap items-center gap-2">
        {files.map((file, idx) => {
          const isImage = file.type.startsWith('image/')
          const blobUrl = blobUrls.get(idx) || ''

          if (isImage) {
            return (
              <div key={idx} className="shrink-0">
                <ImageAttachment
                  src={blobUrl}
                  alt={file.name}
                  removable
                  compact
                  onRemove={() => removeFile(idx)}
                />
              </div>
            )
          }

          return (
            <div key={idx} className="shrink-0">
              <FileCard
                name={file.name}
                mediaType={file.type}
                removable
                onRemove={() => removeFile(idx)}
              />
            </div>
          )
        })}
        </div>
      </div>
    </div>
  ) : null

  return (
    <div className={floating ? '' : 'border-t border-(--color-border) bg-(--color-bg) px-4 py-3'}>
      <div className={floating ? 'relative' : 'relative mx-auto max-w-3xl'}>
        {/* File previews (above when docked at bottom) */}
        {!filesBelow && filePreviews}

        {/* Slash command menu — floating above the input */}
        {slashMenuOpen && filteredSlashCommands.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 z-10 mb-1 overflow-hidden rounded-lg border border-(--color-border) bg-(--color-surface-2) shadow-lg">
            {filteredSlashCommands.map((cmd, idx) => (
              <button
                key={cmd.id}
                onMouseDown={(e) => { e.preventDefault(); executeSlashCommand(cmd) }}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${
                  idx === clampedIndex
                    ? 'bg-(--color-accent-subtle) text-(--color-text)'
                    : 'text-(--color-text-muted) hover:bg-(--color-accent-dim)'
                }`}
              >
                <span className="font-mono text-xs text-(--color-accent)">/{cmd.id}</span>
                <span className="text-(--color-text-2)">{cmd.description}</span>
              </button>
            ))}
          </div>
        )}

        {/* Input pill wrapper — anchors the drag handle to the input itself,
            so it stays pinned to the pill regardless of file previews. */}
        <div className="relative">
          {renderDragHandle?.()}

        {/* Input container */}
        <div
          className={`relative flex items-center gap-2 rounded-2xl border border-(--color-border) px-4 py-2.5 transition-all focus-within:border-(--color-accent) focus-within:ring-1 focus-within:ring-(--color-accent-subtle) ${
            floating
              ? 'bg-(--color-surface-2)/20 shadow-xl backdrop-blur-xl'
              : 'bg-(--color-surface-2)'
          }`}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={disabled}
            placeholder={
              disabled
                ? 'Waiting for response…'
                : isStreaming
                  ? 'Type /stop to interrupt, or click stop…'
                  : placeholder
            }
            rows={1}
            autoFocus={autoFocus}
            className="flex-1 resize-none bg-transparent py-1 text-sm leading-relaxed text-(--color-text) placeholder-(--color-text-muted) focus:outline-none disabled:opacity-50"
            style={{ maxHeight: '144px' }}
            aria-label="Message input"
          />

          {/* Character count */}
          {showCharCount && (
            <span
              className={`shrink-0 self-end pb-1 text-xs ${
                charCount > 2000 ? 'text-(--color-error)' : 'text-(--color-text-muted)'
              }`}
            >
              {charCount}
            </span>
          )}

          {/* Attachment button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            aria-label="Attach file"
            title="Attach file (paste or drag)"
            className="flex h-8 w-8 shrink-0 self-end items-center justify-center rounded-full text-(--color-text-muted) transition-colors hover:bg-(--color-accent-subtle) hover:text-(--color-text) disabled:opacity-25"
          >
            <Paperclip size={14} />
          </button>

          {/* Voice mic button */}
          <VoiceMicButton
            voiceEnabled={voiceEnabled}
            onTranscript={handleVoiceTranscript}
            disabled={disabled}
          />

          {/* Send / Stop button */}
          {canStop && !hasText ? (
            <button
              onClick={onStop}
              aria-label="Stop generation"
              className="flex h-8 w-8 shrink-0 self-end items-center justify-center rounded-full bg-(--color-error) text-(--color-bg) shadow-sm transition-all hover:opacity-80 hover:shadow-md"
            >
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!canSend}
              aria-label="Send message"
              title="Send (Enter) · New line (Shift+Enter) · Commands (/)"
              className="flex h-8 w-8 shrink-0 self-end items-center justify-center rounded-full bg-(--color-accent) text-(--color-bg) shadow-sm transition-all hover:bg-(--color-accent-hover) hover:shadow-md disabled:cursor-not-allowed disabled:opacity-25"
            >
              {disabled ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <ArrowUp size={14} />
              )}
            </button>
          )}
        </div>
        </div>

        {/* File previews (below when floating near top) */}
        {filesBelow && filePreviews}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={buildAcceptString()}
          onChange={handleFileSelect}
          className="hidden"
          aria-hidden="true"
        />
      </div>
    </div>
  )
})
