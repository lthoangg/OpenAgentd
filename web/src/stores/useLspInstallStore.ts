import { create } from 'zustand'

export interface LspInstallRequest {
  workspace: string
  languageServerVersion: string
  typeScriptVersion: string
}

interface LspInstallStore {
  request: LspInstallRequest | null
  requestInstall: (request: LspInstallRequest) => void
  /**
   * Close `request`'s line. A newer request (another folder or computer)
   * that arrived meanwhile stays: an install finishing late must not close
   * a line it was not started from. Without an argument, close any.
   */
  dismiss: (request?: LspInstallRequest) => void
}

export const useLspInstallStore = create<LspInstallStore>((set, get) => ({
  request: null,
  requestInstall: (request) => set({ request }),
  dismiss: (request) => {
    if (request && get().request !== request) return
    set({ request: null })
  },
}))
