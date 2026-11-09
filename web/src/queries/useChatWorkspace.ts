/**
 * The prebuilt chat workspace (pinned sidebar row) from the workspace tree.
 *
 * One source of truth for "is this session's workspace the chat root?" on the
 * client: the sidebar renders the row, the header/title label it, and the
 * dock drops its Git tab for it. The entry comes from the same cached
 * `GET /agent/workspace/tree` response the sidebar already fetches, so this
 * adds no request.
 */
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getCodingWorkspaceTree } from '@/api/client'
import type { CodingWorkspaceTreeChat } from '@/api/types'
import { getChatWorkspaceEntry, sameWorkspacePath, setChatWorkspaceEntry } from '@/utils/workspace'
import { checkoutLabel, type CheckoutLabel } from '@/utils/checkout-label'
import { queryKeys } from './keys'

const CHAT_WORKSPACE_STALE_MS = 30_000

export function useChatWorkspace(): CodingWorkspaceTreeChat | null {
  const { data = null } = useQuery({
    queryKey: queryKeys.coding.tree(),
    queryFn: getCodingWorkspaceTree,
    staleTime: CHAT_WORKSPACE_STALE_MS,
    select: (tree) => tree.chat ?? null,
  })

  // Publish the resolved entry for label helpers called outside React
  // (scheduler badges, window titles) — see ``utils/workspace``.
  useEffect(() => {
    setChatWorkspaceEntry(data)
  }, [data])

  return data
}

/**
 * ``workspace``'s label in two parts (``checkoutLabel``): its repository, and
 * the worktree or subfolder name when it is one. Reads the same cached tree
 * as ``useChatWorkspace``, so it adds no request.
 */
export function useCheckoutLabel(workspace: string | null | undefined): CheckoutLabel | null {
  const { data } = useQuery({
    queryKey: queryKeys.coding.tree(),
    queryFn: getCodingWorkspaceTree,
    staleTime: CHAT_WORKSPACE_STALE_MS,
  })
  if (!workspace) return null
  return checkoutLabel(workspace, data?.repositories, data?.chat ?? getChatWorkspaceEntry())
}

/** Return true when ``workspace`` is the chat root. */
export function isChatWorkspacePath(
  workspace: string | null | undefined,
  chat: CodingWorkspaceTreeChat | null = getChatWorkspaceEntry(),
): boolean {
  return sameWorkspacePath(workspace, chat?.path)
}
