/**
 * OpenAgentd API client — memory group: persistent markdown memory subsystem.
 */

import { apiBaseUrl } from '../base-url'
import { parseDetailOrThrow } from './_shared'

export type MemoryPageSummary = {
  path: string
  title: string
  type: string
}

export type MemoryTreeResponse = {
  pages: MemoryPageSummary[]
}

export type MemoryFileResponse = {
  path: string
  content: string
  etag: string
  frontmatter: Record<string, string | null> | null
}

export type MemorySearchResult = {
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

export async function getMemoryTree(): Promise<MemoryTreeResponse> {
  const res = await fetch(`${apiBaseUrl()}/agent/memory/tree`)
  if (!res.ok) await parseDetailOrThrow(res, 'GET /agent/memory/tree')
  return res.json()
}

export async function getMemoryFile(path: string): Promise<MemoryFileResponse> {
  const params = new URLSearchParams({ path })
  const res = await fetch(`${apiBaseUrl()}/agent/memory/file?${params}`)
  if (!res.ok) await parseDetailOrThrow(res, 'GET /agent/memory/file')
  return res.json()
}

export async function putMemoryFile(
  path: string,
  content: string,
  ifMatch?: string | null,
): Promise<MemoryFileResponse> {
  const params = new URLSearchParams({ path })
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
  ifMatch: string,
): Promise<{ status: string; path: string }> {
  const params = new URLSearchParams({ path })
  const headers: Record<string, string> = { 'If-Match': ifMatch }

  const res = await fetch(`${apiBaseUrl()}/agent/memory/file?${params}`, {
    method: 'DELETE',
    headers,
  })
  if (!res.ok) await parseDetailOrThrow(res, 'DELETE /agent/memory/file')
  return res.json()
}

export async function searchMemory(query: string): Promise<MemorySearchResponse> {
  const params = new URLSearchParams({ query })
  const res = await fetch(`${apiBaseUrl()}/agent/memory/search?${params}`)
  if (!res.ok) await parseDetailOrThrow(res, 'GET /agent/memory/search')
  return res.json()
}

export async function lintMemory(): Promise<MemoryLintReport> {
  const url = `${apiBaseUrl()}/agent/memory/lint`
  const res = await fetch(url, { method: 'POST' })
  if (!res.ok) await parseDetailOrThrow(res, 'POST /agent/memory/lint')
  return res.json()
}
