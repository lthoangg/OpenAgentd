/**
 * Plain formatters behind `getToolDisplay` (display.tsx): argument readers and
 * the per-tool header text for todos, schedules, plans and preview actions.
 */

import type { ToolDisplay } from './types'
import { parsePatchText } from './diffUtils'

/** Extract a non-empty string field from parsed args. */
export function str(parsed: Record<string, unknown>, key: string): string | null {
  const v = parsed[key]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** Truncate a string to maxLen chars, appending ellipsis if cut. */
export function trunc(s: string, maxLen = 60): string {
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s
}

/** ``full``, only when the header shows it cut (``ToolDisplay.fullTarget``). */
export function cutFull(full: string | null, maxLen = 60): string | null {
  return full && full.length > maxLen ? full : null
}

/**
 * The `mcp` call's `arguments`, pretty-printed. Gemini sends them as a
 * JSON-encoded string; an empty object hides the args section.
 */
export function mcpArguments(value: unknown): string | null {
  let v = value
  if (typeof v === 'string') {
    if (!v.trim()) return null
    try {
      v = JSON.parse(v)
    } catch {
      return v as string
    }
  }
  if (v && typeof v === 'object' && Object.keys(v).length > 0) return JSON.stringify(v, null, 2)
  return null
}

/**
 * Render a URL as `host/path?query#hash` — scheme, `www.` and a bare trailing
 * slash dropped, everything else kept so the header identifies the exact page
 * rather than just the site. Unparseable input is returned as-is.
 */
export function shortUrl(url: string): string {
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`)
    const host = parsed.host.replace(/^www\./, '')
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    return `${host}${path}${parsed.search}${parsed.hash}`
  } catch {
    return url
  }
}

export function patchPaths(patchText: string): string[] {
  const paths = parsePatchText(patchText).flatMap((diff) => (
    diff.moveTo ? [diff.path, diff.moveTo] : [diff.path]
  ))
  return [...new Set(paths)]
}

export function actionList(parsed: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(parsed.actions)
    ? (parsed.actions as unknown[]).filter((item): item is Record<string, unknown> => (
        typeof item === 'object' && item !== null && !Array.isArray(item)
      ))
    : []
}

export function formatTodoAction(action: Record<string, unknown>): string {
  const type = str(action, 'action')
  const taskId = str(action, 'task_id')
  if (type === 'create') {
    const content = str(action, 'content') ?? 'Untitled task'
    const status = str(action, 'status')
    const priority = str(action, 'priority')
    const assignedTo = str(action, 'assigned_to')
    const dependencies = Array.isArray(action.dependencies)
      ? (action.dependencies as unknown[]).map(String).filter(Boolean)
      : []
    const metadata = [
      status ? `[${status}]` : null,
      priority ? `(${priority})` : null,
      assignedTo ? `assigned=${assignedTo}` : null,
      dependencies.length > 0 ? `deps=[${dependencies.join(', ')}]` : null,
    ].filter(Boolean).join(' ')
    return `create${metadata ? ` ${metadata}` : ''}: ${content}`
  }
  if (type === 'update') {
    const fields = ['status', 'priority', 'content', 'assigned_to']
      .map((key) => {
        const value = str(action, key)
        return value ? `${key}=${value}` : null
      })
      .filter(Boolean)
    const dependencies = Array.isArray(action.dependencies)
      ? (action.dependencies as unknown[]).map(String).filter(Boolean)
      : []
    if (dependencies.length > 0) fields.push(`dependencies=[${dependencies.join(', ')}]`)
    return `update ${taskId ?? 'todo'}${fields.length > 0 ? `: ${fields.join(', ')}` : ''}`
  }
  if (type === 'claim') return `claim ${taskId ?? 'todo'}`
  if (type === 'delete') return `delete ${taskId ?? 'todo'}`
  if (type === 'read') return 'read todos'
  if (type === 'clear') return `clear ${clearScope(action)} todos`
  return type ? `${type} ${taskId ?? ''}`.trim() : JSON.stringify(action)
}

/** Which todos a `clear` removes: a bare clear empties the board. */
export function clearScope(action: Record<string, unknown>): string {
  const status = str(action, 'status')
  if (status) return status
  // Older boards filtered with a `statuses` list.
  const statuses = Array.isArray(action.statuses) ? action.statuses.map(String).join('/') : ''
  return statuses || 'all'
}

export function formatSchedule(parsed: Record<string, unknown>): string | null {
  const scheduleType = str(parsed, 'schedule_type')
  const timezone = str(parsed, 'timezone')
  const prompt = str(parsed, 'prompt')
  const enabled = parsed.enabled === false ? 'enabled: false' : null
  let schedule: string | null = null
  if (scheduleType === 'at') {
    const at = str(parsed, 'at_datetime')
    schedule = at ? `schedule: at ${at}${timezone ? ` (${timezone})` : ''}` : 'schedule: at ?'
  } else if (scheduleType === 'every') {
    const seconds = parsed.every_seconds != null ? String(parsed.every_seconds) : '?'
    schedule = `schedule: every ${seconds}s`
  } else if (scheduleType === 'cron') {
    const expression = str(parsed, 'cron_expression') ?? '?'
    schedule = `schedule: cron ${expression}${timezone ? ` (${timezone})` : ''}`
  } else if (scheduleType) {
    schedule = `schedule: ${scheduleType}`
  }
  const lines = [schedule, enabled, prompt ? `prompt: ${prompt}` : null].filter(Boolean)
  return lines.length > 0 ? lines.join('\n') : null
}

function planEdits(parsed: Record<string, unknown>): { old: string; new: string }[] {
  if (!Array.isArray(parsed.edits)) return []
  return (parsed.edits as unknown[]).flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const edit = item as Record<string, unknown>
    return [{ old: typeof edit.old === 'string' ? edit.old : '', new: typeof edit.new === 'string' ? edit.new : '' }]
  })
}

function diffLines(prefix: '-' | '+', text: string): string[] {
  return text ? text.split('\n').map((line) => `${prefix} ${line}`) : []
}

// ── plan: write and new show the Markdown, edit a -/+ diff of each replacement ──
export function planDisplay(parsed: Record<string, unknown>): ToolDisplay {
  if (str(parsed, 'action') === 'edit') {
    const edits = planEdits(parsed)
    // History sends a plan's edits short: only their count.
    const count = edits.length || (typeof parsed.edit_count === 'number' ? parsed.edit_count : 0)
    const header = count ? `edit · ${count} ${count === 1 ? 'change' : 'changes'}` : 'edit'
    return {
      header,
      headerTitle: header,
      formattedArgs: edits.length
        ? edits.map((edit) => [...diffLines('-', edit.old), ...diffLines('+', edit.new)].join('\n')).join('\n\n')
        : null,
    }
  }
  const fresh = str(parsed, 'action') === 'new'
  const header = fresh ? 'new' : 'write'
  return { header, headerTitle: header, formattedArgs: typeof parsed.content === 'string' && parsed.content ? parsed.content : null }
}

/** ``Click e3``, ``Fill #email``, ``Go to /pricing``; ``null`` for open and logs. */
export function previewPageActionLabel(action: string, parsed: Record<string, unknown>): string | null {
  const target = str(parsed, 'ref') || str(parsed, 'selector')
  const key = str(parsed, 'key') ?? ''
  const to = str(parsed, 'to') ?? ''
  const text = str(parsed, 'text')
  const withTarget = (verb: string) => (target ? `${verb} ${target}` : verb)
  switch (action) {
    case 'snapshot': return withTarget('Page snapshot')
    case 'click': return withTarget('Click')
    case 'fill': return withTarget('Fill')
    case 'inspect': return withTarget('Inspect')
    case 'press': return target ? `Press ${key} on ${target}` : `Press ${key}`
    case 'scroll': return target || to ? `Scroll to ${target || to}` : 'Scroll'
    case 'navigate': return to ? `Go to ${to}` : 'Navigate'
    case 'wait': {
      const what = text ? `"${text}"` : str(parsed, 'selector')
      if (!what) return 'Wait'
      return parsed.gone === true ? `Wait for ${what} to go` : `Wait for ${what}`
    }
    default: return null
  }
}

/** ``Fill e1 → Click e4 +2 more`` for a chain of page actions (steps may still be streaming). */
export function previewChainLabel(parsed: Record<string, unknown>): { short: string; full: string } {
  const steps = Array.isArray(parsed.steps) ? parsed.steps : []
  const labels = steps.flatMap((step) => {
    if (!step || typeof step !== 'object') return []
    const s = step as Record<string, unknown>
    const action = str(s, 'action')
    const label = action ? previewPageActionLabel(action, s) : null
    return label ? [label] : []
  })
  if (!labels.length) return { short: 'Chain', full: 'Chain' }
  const shown = labels.slice(0, 3).join(' → ')
  return { short: labels.length > 3 ? `${shown} +${labels.length - 3} more` : shown, full: labels.join(' → ') }
}
