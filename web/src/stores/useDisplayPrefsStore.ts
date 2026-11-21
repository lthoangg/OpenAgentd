/**
 * useDisplayPrefsStore — how the app reads on this device, persisted.
 *
 * ``transcriptStyle`` is the app's one Detail setting. ``detailed`` (Full)
 * shows every thinking trace, tool call and number in place. ``reader``
 * (Simple) folds each turn's work behind one summary row (see
 * ``components/ReaderTurn``) and shortens a few numbers around the chat;
 * ``useSimpleDetail`` is what those read.
 *
 * A new install starts in Simple. One that exists keeps what it shows: a
 * stored style is never changed, and an install that stored nothing (it
 * never touched a display setting) is told apart from a new one by its
 * sessions, once (``seedDetail``).
 *
 * ``textSize``: Compact / Default / Large. It is applied to <html> as
 * ``data-text-size``; index.css turns that into ``--oa-text-scale``, which
 * every rem type step multiplies (13px UI text at Default, 12px at Compact).
 * ``public/theme-init.js`` applies the saved size before paint. On iOS the
 * system text size (Dynamic Type) scales the root on top of it.
 *
 * ``previewOpen``: where a page the agent opens with its ``preview`` tool
 * goes. ``panel`` opens it in the Review panel as the call finishes;
 * ``click`` leaves it to the tool row's Open button.
 *
 * ``diffLayout``: a diff tab's layout on desktop, ``unified`` or ``split``
 * (side by side, which falls back to unified in a narrow panel).
 *
 * ``terminalFontPx``: the terminal's text size a pinch set on this device,
 * or ``null`` to follow Text size (``lib/terminal-font.ts``).
 */
import { withViewTransition } from '@/lib/view-transition'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export const DISPLAY_PREFS_STORAGE_KEY = 'oa.display.v1'

export type TranscriptStyle = 'detailed' | 'reader'
export type TextSize = 'compact' | 'default' | 'large'
export type PreviewOpen = 'panel' | 'click'
export type DiffLayout = 'unified' | 'split'

/** A new install's style. */
const NEW_INSTALL_TRANSCRIPT_STYLE: TranscriptStyle = 'reader'
/** What every install showed before Simple became the start: kept for those. */
const EXISTING_INSTALL_TRANSCRIPT_STYLE: TranscriptStyle = 'detailed'
const DEFAULT_TEXT_SIZE: TextSize = 'default'
const DEFAULT_PREVIEW_OPEN: PreviewOpen = 'panel'
const DEFAULT_DIFF_LAYOUT: DiffLayout = 'unified'

export const TRANSCRIPT_STYLES: readonly { value: TranscriptStyle; label: string }[] = [
  { value: 'reader', label: 'Simple' },
  { value: 'detailed', label: 'Full' },
]

export const TEXT_SIZES: readonly { value: TextSize; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'default', label: 'Default' },
  { value: 'large', label: 'Large' },
]

export const PREVIEW_OPENS: readonly { value: PreviewOpen; label: string }[] = [
  { value: 'panel', label: 'Automatically' },
  { value: 'click', label: 'When I choose' },
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
  /** The style is settled: stored by an earlier launch, picked, or seeded. */
  detailSeeded: boolean
  /**
   * Settle the style of an install that stored none, from whether its server
   * already has sessions: one that does existed before and keeps Full.
   * Does nothing once settled.
   */
  seedDetail: (hasSessions: boolean) => void
  textSize: TextSize
  setTranscriptStyle: (style: TranscriptStyle) => void
  /** Detailed ⇄ reader; reads the current style at call time. */
  toggleTranscriptStyle: () => void
  setTextSize: (size: TextSize) => void
  previewOpen: PreviewOpen
  setPreviewOpen: (where: PreviewOpen) => void
  diffLayout: DiffLayout
  setDiffLayout: (layout: DiffLayout) => void
  terminalFontPx: number | null
  setTerminalFontPx: (px: number | null) => void
}

function isTranscriptStyle(value: unknown): value is TranscriptStyle {
  return TRANSCRIPT_STYLES.some((style) => style.value === value)
}

function isTextSize(value: unknown): value is TextSize {
  return TEXT_SIZES.some((size) => size.value === value)
}

function isPreviewOpen(value: unknown): value is PreviewOpen {
  return PREVIEW_OPENS.some((where) => where.value === value)
}

function isDiffLayout(value: unknown): value is DiffLayout {
  return value === 'unified' || value === 'split'
}

function isFontPx(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 8 && value <= 32
}

export const useDisplayPrefsStore = create<DisplayPrefsState>()(
  persist(
    (set, get) => ({
      transcriptStyle: NEW_INSTALL_TRANSCRIPT_STYLE,
      detailSeeded: false,
      seedDetail: (hasSessions) => {
        if (get().detailSeeded) return
        set({ transcriptStyle: hasSessions ? EXISTING_INSTALL_TRANSCRIPT_STYLE : NEW_INSTALL_TRANSCRIPT_STYLE, detailSeeded: true })
      },
      textSize: DEFAULT_TEXT_SIZE,
      setTranscriptStyle: (style) => set({ transcriptStyle: style, detailSeeded: true }),
      toggleTranscriptStyle: () => set({ transcriptStyle: get().transcriptStyle === 'reader' ? 'detailed' : 'reader', detailSeeded: true }),
      setTextSize: (size) => {
        // Every line reflows at once: crossfade it, as the theme does.
        if (get().textSize === size) applyTextSize(size)
        else withViewTransition(() => applyTextSize(size))
        set({ textSize: size })
      },
      previewOpen: DEFAULT_PREVIEW_OPEN,
      setPreviewOpen: (where) => set({ previewOpen: where }),
      diffLayout: DEFAULT_DIFF_LAYOUT,
      setDiffLayout: (layout) => set({ diffLayout: layout }),
      terminalFontPx: null,
      setTerminalFontPx: (px) => set({ terminalFontPx: px }),
    }),
    {
      name: DISPLAY_PREFS_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ transcriptStyle, detailSeeded, textSize, previewOpen, diffLayout, terminalFontPx }) => ({ transcriptStyle, detailSeeded, textSize, previewOpen, diffLayout, terminalFontPx }),
      // Stored without a schema: an unknown value from another build reads
      // as the default rather than as a transcript that renders nothing.
      // Only known keys are kept, which drops v3.18.0's `newSessionComposer`.
      merge: (persisted, current) => {
        const stored = persisted as { transcriptStyle?: unknown; detailSeeded?: unknown; textSize?: unknown; previewOpen?: unknown; diffLayout?: unknown; terminalFontPx?: unknown } | undefined
        const style = stored?.transcriptStyle
        const size = stored?.textSize
        // Nothing stored: a new install, or one that never changed a display
        // setting; ``seedDetail`` tells them apart. Anything stored comes from
        // an install that existed, whose style stays (an unreadable one as Full).
        const detail = stored === undefined
          ? { transcriptStyle: NEW_INSTALL_TRANSCRIPT_STYLE, detailSeeded: false }
          : stored.detailSeeded === false && isTranscriptStyle(style)
            ? { transcriptStyle: style, detailSeeded: false }
            : { transcriptStyle: isTranscriptStyle(style) ? style : EXISTING_INSTALL_TRANSCRIPT_STYLE, detailSeeded: true }
        return {
          ...current,
          ...detail,
          textSize: isTextSize(size) ? size : DEFAULT_TEXT_SIZE,
          previewOpen: isPreviewOpen(stored?.previewOpen) ? stored.previewOpen : DEFAULT_PREVIEW_OPEN,
          diffLayout: isDiffLayout(stored?.diffLayout) ? stored.diffLayout : DEFAULT_DIFF_LAYOUT,
          terminalFontPx: isFontPx(stored?.terminalFontPx) ? stored.terminalFontPx : null,
        }
      },
    },
  ),
)

/** Simple detail is on: the numbers around the chat fold away (see the file header). */
export function useSimpleDetail(): boolean {
  return useDisplayPrefsStore((s) => s.transcriptStyle === 'reader')
}
