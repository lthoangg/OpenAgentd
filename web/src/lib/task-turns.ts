/**
 * Where each task happened: the prompt of the turn whose `todo` call created
 * the task or last changed it, so a row in the Tasks tab can bring that turn
 * into view. A create names its task by text (the tool assigns the id), an
 * update by id. Only loaded turns count: a task last touched on an older
 * page has no turn here, and its row stays plain.
 */
import type { ContentBlock, TodoItem } from '@/api/types'
import { isDirectUserBlock } from '@/stores/useAgentStore/helpers'
import { canonicalToolName } from '@/utils/tool-names'

interface TodoAction {
  action?: unknown
  task_id?: unknown
  content?: unknown
}

function todoActions(args: string | undefined): TodoAction[] {
  if (!args) return []
  try {
    const parsed = JSON.parse(args) as { actions?: unknown; action?: unknown }
    if (Array.isArray(parsed.actions)) return parsed.actions.filter((a): a is TodoAction => !!a && typeof a === 'object')
    return parsed.action !== undefined ? [parsed as TodoAction] : []
  } catch {
    return []
  }
}

/** Task id → the block id of the prompt whose turn last touched it. */
export function taskTurnPrompts(blocks: readonly ContentBlock[], todos: readonly TodoItem[]): Map<string, string> {
  const byContent = new Map(todos.map((t) => [t.content, t.task_id]))
  const turns = new Map<string, string>()
  let promptId: string | null = null
  for (const block of blocks) {
    if (isDirectUserBlock(block)) {
      promptId = block.id
      continue
    }
    if (promptId === null || block.type !== 'tool' || canonicalToolName(block.toolName ?? '') !== 'todo') continue
    for (const action of todoActions(block.toolArgs)) {
      const id = typeof action.task_id === 'string'
        ? action.task_id
        : typeof action.content === 'string' && (action.action === 'create' || action.action === 'add')
          ? byContent.get(action.content)
          : undefined
      if (id) turns.set(id, promptId)
    }
  }
  return turns
}
