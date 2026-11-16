/**
 * What the run deck's "+" control may do to the draft: attach files (the
 * native picker in the app, else the hidden file input), start an ``@`` or
 * ``#`` token at the caret, or replace the draft (a side question's
 * ``/btw ``). The last two focus the message box inside the tap, so iOS
 * raises its keyboard.
 */
// Not compiled, as when this code was part of InputComposer, which the React
// Compiler skipped; compiling it is a change of its own to verify.
'use no memo'
import { useMemo, type Dispatch, type SetStateAction } from 'react'
import type { ComposerActions } from '../composer/PlusMenu'
import type { DesignFeedback } from '@/lib/design-feedback'
import { canPickNatively, pickNatively } from '@/lib/native-pick'
import { findActiveSnippet } from './helpers'
import { findActiveMention } from './mentions'
import type { SuggestionRange } from './suggestionEngine'

export function useComposerActions({
  addAllowedFiles,
  fileInputRef,
  textareaRef,
  setValue,
  setHistoryIndex,
  setDesignFeedback,
  resetDraftState,
  setMentionRange,
  setSnippetRange,
  resize,
  resizeAfterLayout,
  onFileRefsNeeded,
}: {
  addAllowedFiles: (files: File[]) => void
  fileInputRef: React.RefObject<HTMLInputElement | null>
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  setValue: Dispatch<SetStateAction<string>>
  setHistoryIndex: Dispatch<SetStateAction<number>>
  setDesignFeedback: Dispatch<SetStateAction<DesignFeedback[]>>
  resetDraftState: () => void
  setMentionRange: Dispatch<SetStateAction<SuggestionRange>>
  setSnippetRange: Dispatch<SetStateAction<SuggestionRange>>
  resize: () => void
  resizeAfterLayout: (andThen?: () => void) => () => void
  onFileRefsNeeded?: () => void
}): ComposerActions {
  return useMemo<ComposerActions>(() => ({
    attach: (kind) => {
      if (kind && canPickNatively()) {
        void pickNatively(kind).then((picked) => { if (picked.length > 0) addAllowedFiles(picked) }).catch(() => {})
        return
      }
      fileInputRef.current?.click()
    },
    startToken: (token) => {
      const el = textareaRef.current
      const current = el?.value ?? ''
      const start = el?.selectionStart ?? current.length
      const end = el?.selectionEnd ?? start
      // A token starts a word: put a space before it unless one is there.
      const lead = start > 0 && !/\s/.test(current[start - 1] ?? '') ? ' ' : ''
      const inserted = `${lead}${token}`
      const next = current.slice(0, start) + inserted + current.slice(end)
      const caret = start + inserted.length
      setValue(next)
      setHistoryIndex(-1)
      // Now, inside the tap (the keyboard on iOS), then again with the caret.
      el?.focus({ preventScroll: true })
      requestAnimationFrame(() => {
        el?.focus({ preventScroll: true })
        el?.setSelectionRange(caret, caret)
        const mention = findActiveMention(next, caret)
        if (mention) onFileRefsNeeded?.()
        setMentionRange(mention)
        setSnippetRange(mention ? null : findActiveSnippet(next, caret))
        resize()
      })
    },
    setDraft: (text) => {
      setValue(text)
      setDesignFeedback([])
      resetDraftState()
      // Focus now, inside the gesture that asked (iOS raises the keyboard
      // only then); the caret moves to the end once the text has laid out.
      textareaRef.current?.focus({ preventScroll: true })
      resizeAfterLayout(() => {
        const el = textareaRef.current
        el?.focus({ preventScroll: true })
        el?.setSelectionRange(text.length, text.length)
      })
    },
  }), [addAllowedFiles, fileInputRef, onFileRefsNeeded, resetDraftState, resize, resizeAfterLayout, setDesignFeedback, setHistoryIndex, setMentionRange, setSnippetRange, setValue, textareaRef])
}
