/** TanStack Query hooks for the persistent memory subsystem. */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getMemoryTree,
  getMemoryFile,
  putMemoryFile,
  deleteMemoryFile,
  lintMemory,
  type MemoryScopeKind,
} from '@/api/client'
import { queryKeys } from './keys'

export function useMemoryTreeQuery(scope: MemoryScopeKind = 'global', workspace?: string | null) {
  return useQuery({
    queryKey: queryKeys.memory.tree(scope, workspace),
    queryFn: () => getMemoryTree(scope, workspace),
    staleTime: 5_000,
  })
}

export function useMemoryFileQuery(
  path: string | null,
  scope: MemoryScopeKind = 'global',
  workspace?: string | null,
) {
  return useQuery({
    queryKey: queryKeys.memory.file(path ?? '', scope, workspace),
    queryFn: () => getMemoryFile(path as string, scope, workspace),
    enabled: !!path,
    staleTime: 5_000,
  })
}

export function useMemoryLintQuery(workspace?: string | null, enabled: boolean = false) {
  return useQuery({
    queryKey: queryKeys.memory.lint(workspace),
    queryFn: () => lintMemory(workspace),
    enabled,
  })
}

export function useSaveMemoryFileMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({
      path,
      content,
      scope,
      ifMatch,
      workspace,
    }: {
      path: string
      content: string
      scope: MemoryScopeKind
      ifMatch?: string | null
      workspace?: string | null
    }) => putMemoryFile(path, content, scope, ifMatch, workspace),
    onSuccess: (_data, vars) => {
      client.invalidateQueries({ queryKey: queryKeys.memory.tree(vars.scope, vars.workspace) })
      client.invalidateQueries({ queryKey: queryKeys.memory.file(vars.path, vars.scope, vars.workspace) })
      client.invalidateQueries({ queryKey: queryKeys.memory.lint(vars.workspace) })
    },
  })
}

export function useDeleteMemoryFileMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({
      path,
      scope,
      ifMatch,
      workspace,
    }: {
      path: string
      scope: MemoryScopeKind
      ifMatch: string
      workspace?: string | null
    }) => deleteMemoryFile(path, scope, ifMatch, workspace),
    onSuccess: (_data, vars) => {
      client.invalidateQueries({ queryKey: queryKeys.memory.tree(vars.scope, vars.workspace) })
      client.invalidateQueries({ queryKey: queryKeys.memory.file(vars.path, vars.scope, vars.workspace) })
      client.invalidateQueries({ queryKey: queryKeys.memory.lint(vars.workspace) })
    },
  })
}
