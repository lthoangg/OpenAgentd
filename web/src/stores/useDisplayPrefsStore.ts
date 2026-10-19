/**
 * useDisplayPrefsStore — how the transcript reads, persisted per device.
 *
 * ``detailed`` shows every thinking trace and tool call in place. ``reader``
 * folds each turn's work behind one summary row and lists the files it
 * edited after the answer (see ``components/ReaderTurn``).
 *
 * ``newSessionComposer`` places the composer on the new-session screen
 * (desktop only; phones always dock it): ``centered`` puts the full box in
 * the screen's hero, ``floating`` keeps the collapsible bar at the bottom.
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

export type NewSessionComposer = 'centered' | 'floating'

const DEFAULT_NEW_SESSION_COMPOSER: NewSessionComposer = 'centered'

export const NEW_SESSION_COMPOSERS: readonly { value: NewSessionComposer; label: string }[] = [
  { value: 'centered', label: 'Centered' },
  { value: 'floating', label: 'Floating' },
]

interface DisplayPrefsState {
  transcriptStyle: TranscriptStyle
  setTranscriptStyle: (style: TranscriptStyle) => void
  /** Detailed ⇄ reader; reads the current style at call time. */
  toggleTranscriptStyle: () => void
  newSessionComposer: NewSessionComposer
  setNewSessionComposer: (placement: NewSessionComposer) => void
}

function isTranscriptStyle(value: unknown): value is TranscriptStyle {
  return TRANSCRIPT_STYLES.some((style) => style.value === value)
}

function isNewSessionComposer(value: unknown): value is NewSessionComposer {
  return NEW_SESSION_COMPOSERS.some((option) => option.value === value)
}

export const useDisplayPrefsStore = create<DisplayPrefsState>()(
  persist(
    (set, get) => ({
      transcriptStyle: DEFAULT_TRANSCRIPT_STYLE,
      setTranscriptStyle: (style) => set({ transcriptStyle: style }),
      toggleTranscriptStyle: () => set({ transcriptStyle: get().transcriptStyle === 'reader' ? 'detailed' : 'reader' }),
      newSessionComposer: DEFAULT_NEW_SESSION_COMPOSER,
      setNewSessionComposer: (placement) => set({ newSessionComposer: placement }),
    }),
    {
      name: DISPLAY_PREFS_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ transcriptStyle, newSessionComposer }) => ({ transcriptStyle, newSessionComposer }),
      // Stored without a schema: an unknown style from another build reads
      // as the default rather than as a transcript that renders nothing.
      merge: (persisted, current) => {
        const stored = persisted as { transcriptStyle?: unknown; newSessionComposer?: unknown } | undefined
        const style = stored?.transcriptStyle
        const composer = stored?.newSessionComposer
        return {
          ...current,
          transcriptStyle: isTranscriptStyle(style) ? style : DEFAULT_TRANSCRIPT_STYLE,
          newSessionComposer: isNewSessionComposer(composer) ? composer : DEFAULT_NEW_SESSION_COMPOSER,
        }
      },
    },
  ),
)
