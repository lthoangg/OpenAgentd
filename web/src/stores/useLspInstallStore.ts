import { create } from 'zustand'

export interface LspInstallRequest {
  workspace: string
  languageServerVersion: string
  typeScriptVersion: string
}

interface LspInstallStore {
  request: LspInstallRequest | null
  requestInstall: (request: LspInstallRequest) => void
  dismiss: () => void
}

export const useLspInstallStore = create<LspInstallStore>((set) => ({
  request: null,
  requestInstall: (request) => set({ request }),
  dismiss: () => set({ request: null }),
}))
