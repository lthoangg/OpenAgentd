import { apiBaseUrl } from '@/api/base-url'
import { browseWorkspaces, validateWorkspace } from '@/api/client'
import { getAppBackendStatus } from '@/lib/app-backend'
import { isLocalBackendUrl } from './utils'

export interface WorkspaceBrowserState {
  path: string
  parent: string | null
  directories: Array<{ name: string; path: string }>
}

/** The OS folder picker of the desktop app; null when the user cancels. */
export async function pickWorkspaceDirectory(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    directory: true,
    multiple: false,
    title: 'Open workspace',
  })
  return typeof selected === 'string' ? selected : null
}

export async function loadWorkspaceBrowser(
  path?: string | null,
): Promise<WorkspaceBrowserState> {
  const result = await browseWorkspaces(path)
  return {
    path: result.path,
    parent: result.parent,
    directories: result.directories,
  }
}

export async function validateTrustedWorkspace(path: string): Promise<string> {
  const result = await validateWorkspace(path)
  return result.workspace
}

export async function shouldUseServerWorkspaceBrowser(
  isTauri: boolean,
  isTauriMobile: boolean,
): Promise<boolean> {
  if (!isTauri || isTauriMobile) return true

  const backendBaseUrl = apiBaseUrl().replace(/\/api\/?$/, '')
  const backend = await getAppBackendStatus()
  const activeBackendBaseUrl = backend?.base_url ?? backendBaseUrl
  const isAbsoluteBackendUrl = /^https?:\/\//i.test(activeBackendBaseUrl)

  return (
    (backend?.external || (!backend && isAbsoluteBackendUrl)) &&
    !isLocalBackendUrl(activeBackendBaseUrl)
  )
}
