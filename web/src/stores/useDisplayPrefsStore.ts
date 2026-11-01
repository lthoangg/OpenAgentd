/**
 * useDisplayPrefsStore — how the app reads on this device, persisted.
 *
 * ``transcriptStyle``: ``detailed`` shows every thinking trace and tool call
 * in place. ``reader`` folds each turn's work behind one summary row and lists
 * the files it edited after the answer (see ``components/ReaderTurn``).
 *
 * ``textSize``: Compact / Default / Large. It is applied to <html> as
 * ``data-text-size``; index.css turns that into ``--oa-text-scale``, which
 * every rem type step multiplies (13px UI text at Default, 12px at Compact).
 * ``public/theme-init.js`` applies the saved size before paint. On iOS the
 * system text size (Dynamic Type) scales the root on top of it.
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export const DISPLAY_PREFS_STORAGE_KEY = 'oa.display.v1'

export type TranscriptStyle = 'detailed' | 'reader'
export type TextSize = 'compact' | 'default' | 'large'

const DEFAULT_TRANSCRIPT_STYLE: TranscriptStyle = 'detailed'
const DEFAULT_TEXT_SIZE: TextSize = 'default'

export const TRANSCRIPT_STYLES: readonly { value: TranscriptStyle; label: string }[] = [
  { value: 'detailed', label: 'Detailed' },
  { value: 'reader', label: 'Reader' },
]

export const TEXT_SIZES: readonly { value: TextSize; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'default', label: 'Default' },
  { value: 'large', label: 'Large' },
]

/** UI text px at each size over the 12px design size (mirrors index.css). */
const TEXT_SIZE_UI_PX: Record<TextSize, number> = { compact: 12, default: 13, large: 14 }

export function textSizeScale(size: TextSize): number {
  return TEXT_SIZE_UI_PX[size] / 12
}

/** Put ``size`` on <html> as ``data-text-size`` (index.css maps it to a scale). */
export function applyTextSize(size: TextSize, root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement): void {
  if (!root) return
  root.dataset.textSize = size
}

interface DisplayPrefsState {
  transcriptStyle: TranscriptStyle
  textSize: TextSize
  setTranscriptStyle: (style: TranscriptStyle) => void
  /** Detailed ⇄ reader; reads the current style at call time. */
  toggleTranscriptStyle: () => void
  setTextSize: (size: TextSize) => void
}

function isTranscriptStyle(value: unknown): value is TranscriptStyle {
  return TRANSCRIPT_STYLES.some((style) => style.value === value)
}

function isTextSize(value: unknown): value is TextSize {
  return TEXT_SIZES.some((size) => size.value === value)
}

export const useDisplayPrefsStore = create<DisplayPrefsState>()(
  persist(
    (set, get) => ({
      transcriptStyle: DEFAULT_TRANSCRIPT_STYLE,
      textSize: DEFAULT_TEXT_SIZE,
      setTranscriptStyle: (style) => set({ transcriptStyle: style }),
      toggleTranscriptStyle: () => set({ transcriptStyle: get().transcriptStyle === 'reader' ? 'detailed' : 'reader' }),
      setTextSize: (size) => {
        applyTextSize(size)
        set({ textSize: size })
      },
    }),
    {
      name: DISPLAY_PREFS_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ transcriptStyle, textSize }) => ({ transcriptStyle, textSize }),
      // Stored without a schema: an unknown value from another build reads
      // as the default rather than as a transcript that renders nothing.
      // Only known keys are kept, which drops v3.18.0's `newSessionComposer`.
      merge: (persisted, current) => {
        const stored = persisted as { transcriptStyle?: unknown; textSize?: unknown } | undefined
        const style = stored?.transcriptStyle
        const size = stored?.textSize
        return {
          ...current,
          transcriptStyle: isTranscriptStyle(style) ? style : DEFAULT_TRANSCRIPT_STYLE,
          textSize: isTextSize(size) ? size : DEFAULT_TEXT_SIZE,
        }
      },
    },
  ),
)
