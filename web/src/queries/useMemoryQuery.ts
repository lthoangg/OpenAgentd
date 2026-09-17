/** TanStack Query hooks for the persistent memory subsystem. */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getMemoryTree,
  getMemoryFile,
  putMemoryFile,
  deleteMemoryFile,
  lintMemory,
} from '@/api/client'
import { queryKeys } from './keys'

export function useMemoryTreeQuery() {
  return useQuery({
    queryKey: queryKeys.memory.tree(),
    queryFn: () => getMemoryTree(),
    staleTime: 5_000,
  })
}

export function useMemoryFileQuery(path: string | null) {
  return useQuery({
    queryKey: queryKeys.memory.file(path ?? ''),
    queryFn: () => getMemoryFile(path as string),
    enabled: !!path,
    staleTime: 5_000,
  })
}

export function useMemoryLintQuery(enabled: boolean = false) {
  return useQuery({
    queryKey: queryKeys.memory.lint(),
    queryFn: () => lintMemory(),
    enabled,
  })
}

export function useSaveMemoryFileMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({
      path,
      content,
      ifMatch,
    }: {
      path: string
      content: string
      ifMatch?: string | null
    }) => putMemoryFile(path, content, ifMatch),
    onSuccess: (_data, vars) => {
      client.invalidateQueries({ queryKey: queryKeys.memory.tree() })
      client.invalidateQueries({ queryKey: queryKeys.memory.file(vars.path) })
      client.invalidateQueries({ queryKey: queryKeys.memory.lint() })
    },
  })
}

export function useDeleteMemoryFileMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({
      path,
      ifMatch,
    }: {
      path: string
      ifMatch: string
    }) => deleteMemoryFile(path, ifMatch),
    onSuccess: (_data, vars) => {
      client.invalidateQueries({ queryKey: queryKeys.memory.tree() })
      client.invalidateQueries({ queryKey: queryKeys.memory.file(vars.path) })
      client.invalidateQueries({ queryKey: queryKeys.memory.lint() })
    },
  })
}
