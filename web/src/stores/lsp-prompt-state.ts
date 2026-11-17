import { defineMachine } from '@/lib/machine'

export interface LspInstallRequest {
  workspace: string
  languageServerVersion: string
  typeScriptVersion: string
}

/**
 * The TypeScript tools line (``LspInstallPrompt``): asking, installing, or
 * asking again after a failure (Retry). An install's reply names the
 * request it was started from, so one finishing late never closes or marks
 * a line it was not started from (another folder or computer asking).
 */
export type LspPrompt =
  | { kind: 'none' }
  | { kind: 'asking'; request: LspInstallRequest; failed: boolean }
  | { kind: 'installing'; request: LspInstallRequest }

export type LspPromptEvent =
  | { type: 'request'; request: LspInstallRequest }
  | { type: 'install'; request: LspInstallRequest }
  | { type: 'installed'; request: LspInstallRequest }
  | { type: 'installFailed'; request: LspInstallRequest }
  /** Later, or the server says the tools are there. Without a request, closes any. */
  | { type: 'dismiss'; request?: LspInstallRequest }

export const LSP_NONE: LspPrompt = { kind: 'none' }
export const lspAsking = (request: LspInstallRequest): LspPrompt => ({ kind: 'asking', request, failed: false })

/** The same folder, server and versions: the server asks again while a line is up. */
export const sameLspRequest = (a: LspInstallRequest, b: LspInstallRequest): boolean =>
  a.workspace === b.workspace && a.languageServerVersion === b.languageServerVersion && a.typeScriptVersion === b.typeScriptVersion
const ours = (s: LspPrompt, request: LspInstallRequest | undefined) =>
  s.kind !== 'none' && (request === undefined || sameLspRequest(s.request, request))
// The same request again keeps the line as it is (an install under way, a Retry).
const ask = (s: LspPrompt, e: { request: LspInstallRequest }) => (ours(s, e.request) ? s : lspAsking(e.request))
const dismiss = (s: LspPrompt, e: { request?: LspInstallRequest }) => (ours(s, e.request) ? LSP_NONE : s)
// A reply for a line that has gone, or for another request: nothing to do.
const stale = (s: LspPrompt) => s

export const lspPromptMachine = defineMachine<LspPrompt, LspPromptEvent>('lsp install prompt', {
  none: { request: ask, dismiss, installed: stale, installFailed: stale },
  asking: {
    request: ask,
    install: (s, e) => (sameLspRequest(s.request, e.request) ? { kind: 'installing', request: s.request } : s),
    dismiss,
    installed: stale,
    installFailed: stale,
  },
  installing: {
    // A newer request shows; the running install's reply is then stale.
    request: ask,
    installed: (s, e) => (sameLspRequest(s.request, e.request) ? LSP_NONE : s),
    installFailed: (s, e) => (sameLspRequest(s.request, e.request) ? { kind: 'asking', request: s.request, failed: true } : s),
    dismiss,
  },
})

export const lspRequestOf = (prompt: LspPrompt): LspInstallRequest | null => (prompt.kind === 'none' ? null : prompt.request)
