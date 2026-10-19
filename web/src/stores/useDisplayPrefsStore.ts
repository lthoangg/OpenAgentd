/**
 * useDisplayPrefsStore — how the transcript reads, persisted per device.
 *
 * ``detailed`` shows every thinking trace and tool call in place. ``reader``
 * folds each turn's work behind one summary row and lists the files it
 * edited after the answer (see ``components/ReaderTurn``).
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export const DISPLAY_PREFS_STORAGE_KEY = 'oa.display.v1'

export type TranscriptStyle = 'detailed' | 'reader'

const DEFAULT_TRANSCRIPT_STYLE: TranscriptStyle = 'detailed'

export const TRANSCRIPT_STYLES: readonly { value: TranscriptStyle; label: string }[] = [
  { value: 'detailed', label: 'Detailed' },
  { value: 'reader', label: 'Reader' },
]

interface DisplayPrefsState {
  transcriptStyle: TranscriptStyle
  setTranscriptStyle: (style: TranscriptStyle) => void
  /** Detailed ⇄ reader; reads the current style at call time. */
  toggleTranscriptStyle: () => void
}

function isTranscriptStyle(value: unknown): value is TranscriptStyle {
  return TRANSCRIPT_STYLES.some((style) => style.value === value)
}

export const useDisplayPrefsStore = create<DisplayPrefsState>()(
  persist(
    (set, get) => ({
      transcriptStyle: DEFAULT_TRANSCRIPT_STYLE,
      setTranscriptStyle: (style) => set({ transcriptStyle: style }),
      toggleTranscriptStyle: () => set({ transcriptStyle: get().transcriptStyle === 'reader' ? 'detailed' : 'reader' }),
    }),
    {
      name: DISPLAY_PREFS_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ transcriptStyle }) => ({ transcriptStyle }),
      // Stored without a schema: an unknown style from another build reads
      // as the default rather than as a transcript that renders nothing.
      // Only known keys are kept, which drops v3.18.0's `newSessionComposer`.
      merge: (persisted, current) => {
        const stored = persisted as { transcriptStyle?: unknown } | undefined
        const style = stored?.transcriptStyle
        return {
          ...current,
          transcriptStyle: isTranscriptStyle(style) ? style : DEFAULT_TRANSCRIPT_STYLE,
        }
      },
    },
  ),
)
