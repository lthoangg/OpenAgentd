/**
 * OpenAgentd API client — memory group: persistent markdown memory subsystem.
 */

import { apiBaseUrl } from '../base-url'
import { parseDetailOrThrow } from './_shared'

export type MemoryScopeKind = 'global' | 'workspace'

export type MemoryPageSummary = {
  path: string
  title: string
  type: string
  scope: MemoryScopeKind
}

export type MemoryTreeResponse = {
  pages: MemoryPageSummary[]
}

export type MemoryFileResponse = {
  path: string
  content: string
  etag: string
  scope: MemoryScopeKind
  frontmatter: Record<string, string | null> | null
}

export type MemorySearchResult = {
  scope: MemoryScopeKind
  path: string
  title: string
}

export type MemorySearchResponse = {
  results: MemorySearchResult[]
}

export type MemoryFindingItem = {
  code: string
  path: string
  message: string
}

export type MemoryLintReport = {
  findings: MemoryFindingItem[]
}

export async function getMemoryTree(
  scope: MemoryScopeKind = 'global',
  workspace?: string | null,
): Promise<MemoryTreeResponse> {
  const params = new URLSearchParams({ scope })
  if (workspace) params.set('workspace', workspace)
  const res = await fetch(`${apiBaseUrl()}/agent/memory/tree?${params}`)
  if (!res.ok) await parseDetailOrThrow(res, 'GET /agent/memory/tree')
  return res.json()
}

export async function getMemoryFile(
  path: string,
  scope: MemoryScopeKind = 'global',
  workspace?: string | null,
): Promise<MemoryFileResponse> {
  const params = new URLSearchParams({ path, scope })
  if (workspace) params.set('workspace', workspace)
  const res = await fetch(`${apiBaseUrl()}/agent/memory/file?${params}`)
  if (!res.ok) await parseDetailOrThrow(res, 'GET /agent/memory/file')
  return res.json()
}

export async function putMemoryFile(
  path: string,
  content: string,
  scope: MemoryScopeKind = 'global',
  ifMatch?: string | null,
  workspace?: string | null,
): Promise<MemoryFileResponse> {
  const params = new URLSearchParams({ path, scope })
  if (workspace) params.set('workspace', workspace)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (ifMatch) headers['If-Match'] = ifMatch

  const res = await fetch(`${apiBaseUrl()}/agent/memory/file?${params}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ content }),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'PUT /agent/memory/file')
  return res.json()
}

export async function deleteMemoryFile(
  path: string,
  scope: MemoryScopeKind = 'global',
  ifMatch: string,
  workspace?: string | null,
): Promise<{ status: string; path: string }> {
  const params = new URLSearchParams({ path, scope })
  if (workspace) params.set('workspace', workspace)
  const headers: Record<string, string> = { 'If-Match': ifMatch }

  const res = await fetch(`${apiBaseUrl()}/agent/memory/file?${params}`, {
    method: 'DELETE',
    headers,
  })
  if (!res.ok) await parseDetailOrThrow(res, 'DELETE /agent/memory/file')
  return res.json()
}

export async function searchMemory(
  query: string,
  workspace?: string | null,
): Promise<MemorySearchResponse> {
  const params = new URLSearchParams({ query })
  if (workspace) params.set('workspace', workspace)
  const res = await fetch(`${apiBaseUrl()}/agent/memory/search?${params}`)
  if (!res.ok) await parseDetailOrThrow(res, 'GET /agent/memory/search')
  return res.json()
}

export async function lintMemory(
  workspace?: string | null,
): Promise<MemoryLintReport> {
  const params = new URLSearchParams()
  if (workspace) params.set('workspace', workspace)
  const url = `${apiBaseUrl()}/agent/memory/lint${params.toString() ? `?${params}` : ''}`
  const res = await fetch(url, { method: 'POST' })
  if (!res.ok) await parseDetailOrThrow(res, 'POST /agent/memory/lint')
  return res.json()
}
