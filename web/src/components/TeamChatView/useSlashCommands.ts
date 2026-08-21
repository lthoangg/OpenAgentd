/**
 * useSlashCommands — slash-command / snippet assembly and dispatch for the
 * composer.
 *
 * Owns:
 *   - Fetching user-defined commands + snippets (workspace-scoped queries).
 *   - Assembling the ``SlashCommand[]`` / ``SnippetCommand[]`` lists the
 *     ``InputComposer`` renders in its picker (built-ins + backend-discovered).
 *   - Dispatching a picked slash command (``stop`` / ``continue`` /
 *     ``compact`` / ``undo`` / ``redo`` / ``redo-all`` / ``new`` / ``init`` — team-lifecycle
 *     actions read straight off ``useTeamStore.getState()`` since they're
 *     one-shot imperative calls, not part of the render subscription).
 *   - Expanding a user-defined ``/command`` at submit time by rendering it
 *     server-side (``expandUserCommand``), used by the composer to swap the
 *     typed shorthand for its full body before sending.
 */
import { useCallback, useMemo } from 'react'
import type { RefObject } from 'react'
import { useCommandsQuery } from '@/queries/useCommandsQuery'
import { useSnippetsQuery } from '@/queries/useSnippetsQuery'
import { renderCommand, renderSnippet } from '@/api/client'
import { useTeamStore } from '@/stores/useTeamStore'
import { useToastStore } from '@/stores/useToastStore'
import { type InputComposerHandle, type SlashCommand, type SnippetCommand } from '../InputComposer'
import { filterBaseSlashCommands, attachmentToFile } from './helpers'

export interface UseSlashCommandsArgs {
  mode: 'normal' | 'coding'
  /** Coding workspace path, or `null` in normal mode / no workspace attached. */
  agentWorkspace: string | null
  inputRef: RefObject<InputComposerHandle | null>
  handleNewSession: () => void
  isTeamWorking?: boolean
  revertedCount?: number
  hasVisibleMessages?: boolean
}

export interface UseSlashCommandsResult {
  slashCommands: SlashCommand[]
  snippetCommands: SnippetCommand[]
  /** Set of known user-defined command names — used by ``expandUserCommand``. */
  userCommandNames: Set<string>
  handleSlashCommand: (id: string) => void
  handleSnippetCommand: (id: string) => Promise<string | null>
  /** If *content* starts with a known user-defined command, render server-side
   *  and return the expanded body; otherwise return *content* unchanged. */
  expandUserCommand: (content: string) => Promise<string>
}

export function useSlashCommands({
  mode,
  agentWorkspace,
  inputRef,
  handleNewSession,
  isTeamWorking = false,
  revertedCount = 0,
  hasVisibleMessages = false,
}: UseSlashCommandsArgs): UseSlashCommandsResult {
  const pushToast = useToastStore((s) => s.push)

  // Slash commands for the input bar (type / to trigger).
  // Built-ins execute immediately on pick; user-defined commands are inserted
  // into the textarea (``keepInputOpen``) so the user can append
  // ``$ARGUMENTS`` before submitting.
  const commandsQ = useCommandsQuery(agentWorkspace)
  const snippetsQ = useSnippetsQuery(mode === 'coding' ? agentWorkspace : null)
  const userCommandNames = useMemo(
    () => new Set<string>((commandsQ.data?.commands ?? []).map((c) => c.name)),
    [commandsQ.data],
  )
  const baseCommands = useMemo(
    () =>
      filterBaseSlashCommands({
        isTeamWorking,
        revertedCount,
        hasVisibleMessages,
        mode,
        hasWorkspace: Boolean(agentWorkspace),
      }),
    [isTeamWorking, revertedCount, hasVisibleMessages, mode, agentWorkspace],
  )

  const slashCommands: SlashCommand[] = useMemo(() => [
    ...baseCommands,
    ...(commandsQ.data?.commands ?? []).map((c) => {
      const displayName = c.name.replace('/', ':')
      return {
        id: c.name,
        label: displayName,
        displayName,
        insertText: displayName,
        description: c.description || `Custom command (${c.source})`,
        category: 'command',
        keepInputOpen: true,
      }
    }),
  ], [baseCommands, commandsQ.data?.commands])

  const snippetCommands: SnippetCommand[] = (snippetsQ.data?.snippets ?? []).map((item) => ({
    id: item.name,
    label: item.name.replace('/', ':'),
    description: item.description || `Snippet (${item.source})`,
    category: 'snippet',
  }))

  const handleSnippetCommand = useCallback(async (id: string) => {
    if (!agentWorkspace) return null
    try {
      const res = await renderSnippet(id, agentWorkspace)
      return res.content
    } catch (err) {
      pushToast({
        tone: 'error',
        title: `Failed to render #${id.replace('/', ':')}`,
        description: (err as Error).message,
      })
      return null
    }
  }, [agentWorkspace, pushToast])

  const handleSlashCommand = useCallback((id: string) => {
    switch (id) {
      case 'stop':
        useTeamStore.getState().stopTeam()
        break
      case 'compact':
        useTeamStore.getState().compactTeam()
        break
      case 'undo':
        void useTeamStore.getState().undoTeam().then(async (response) => {
          const message = response?.message
          if (!message || message.role !== 'user' || message.is_summary) return
          inputRef.current?.setValue(message.content ?? '')
          const attachments = message.attachments ?? []
          const files = (
            await Promise.all(attachments.map((att) => attachmentToFile(att)))
          ).filter((file): file is File => file !== null)
          inputRef.current?.setFiles(files)
          inputRef.current?.focus()
        })
        break
      case 'redo':
        void useTeamStore.getState().redoTeam().then(() => {
          inputRef.current?.setValue('')
          inputRef.current?.setFiles([])
        })
        break
      case 'redo-all':
        void useTeamStore.getState().redoAllTeam().then(() => {
          inputRef.current?.setValue('')
          inputRef.current?.setFiles([])
        })
        break
      case 'new':
        handleNewSession()
        break
      case 'init':
        // Prompt body lives on the backend so it can be tweaked without a
        // web rebuild and stays the single source of truth.
        void renderCommand('init', '', agentWorkspace)
          .then((res) =>
            useTeamStore.getState().sendMessage(res.content, undefined, {
              mode,
              workspace: agentWorkspace,
            }),
          )
          .catch((err: Error) =>
            pushToast({
              tone: 'error',
              title: 'Failed to start /init',
              description: err.message,
            }),
          )
        break
    }
  }, [handleNewSession, inputRef, mode, agentWorkspace, pushToast])

  /** If *content* starts with a known user-defined command, render server-side
   *  and return the expanded body; otherwise return *content* unchanged. */
  const expandUserCommand = useCallback(
    async (content: string): Promise<string> => {
      if (!content.startsWith('/')) return content
      // The command name may include slashes (nested folders), so we
      // greedily match the longest known prefix instead of splitting on
      // the first space. Tokens are separated by whitespace.
      const rest = content.slice(1)
      // Try progressively shorter prefixes — start with the full first
      // line, peel back to the longest known command name.
      const firstLine = rest.split('\n', 1)[0]
      const tokens = firstLine.split(' ')
      for (let n = tokens.length; n > 0; n--) {
        const candidate = tokens.slice(0, n).join(' ').trim()
        const commandName = candidate.replace(':', '/')
        if (userCommandNames.has(commandName)) {
          const argsHead = tokens.slice(n).join(' ')
          const restOfMessage = rest.slice(firstLine.length)
          const args = (argsHead + restOfMessage).trim()
          try {
            const res = await renderCommand(commandName, args, agentWorkspace)
            return res.content
          } catch (err) {
            pushToast({
              tone: 'error',
              title: `Failed to render /${candidate}`,
              description: (err as Error).message,
            })
            return content
          }
        }
      }
      return content
    },
    [userCommandNames, agentWorkspace, pushToast],
  )

  return {
    slashCommands,
    snippetCommands,
    userCommandNames,
    handleSlashCommand,
    handleSnippetCommand,
    expandUserCommand,
  }
}
