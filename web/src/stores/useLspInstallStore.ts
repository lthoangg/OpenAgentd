import { create } from 'zustand'
import { LSP_NONE, lspPromptMachine, type LspInstallRequest, type LspPrompt, type LspPromptEvent } from '@/stores/lsp-prompt-state'

export type { LspInstallRequest } from '@/stores/lsp-prompt-state'

interface LspInstallStore {
  /** Changed only through ``lspPromptMachine`` (``lsp-prompt-state.ts``). */
  lspPrompt: LspPrompt
  requestInstall: (request: LspInstallRequest) => void
  /**
   * Close `request`'s line. A newer request (another folder or computer)
   * that arrived meanwhile stays: an install finishing late must not close
   * a line it was not started from. Without an argument, close any.
   */
  dismiss: (request?: LspInstallRequest) => void
  /** The install for `request` started, succeeded or failed. */
  move: (event: LspPromptEvent) => void
}

export const useLspInstallStore = create<LspInstallStore>((set) => {
  const move = (event: LspPromptEvent) => set((s) => ({ lspPrompt: lspPromptMachine.transition(s.lspPrompt, event) }))
  return {
    lspPrompt: LSP_NONE,
    requestInstall: (request) => move({ type: 'request', request }),
    dismiss: (request) => move({ type: 'dismiss', request }),
    move,
  }
})
