/**
 * Per-tool header / args customisation.
 *
 * Most tools already have clear, short args that look fine as
 * pretty-printed JSON — adding config for them would be complexity with
 * no UX gain.  Only tools where the default JSON display is actively
 * unhelpful get customised here.
 *
 * The file mixes a component (``Arg``, kept private) with the
 * ``getToolDisplay`` registry; React Fast Refresh's "components-only"
 * rule is disabled because the component is colocated with the data it
 * decorates.
 */

/* eslint-disable react-refresh/only-export-components */

import type { ReactNode } from 'react'
import type { ToolDisplay } from './types'
import { parsePatchText } from './diffUtils'
import { pathBasename } from '@/utils/workspace'
import { summarizeText, parsePartialJSON } from './displayText'

/**
 * Keep argument values in headers easy to restyle consistently.
 */
function Arg({ children }: { children: ReactNode }) {
  return <span>{children}</span>
}

/** Extract a non-empty string field from parsed args. */
function str(parsed: Record<string, unknown>, key: string): string | null {
  const v = parsed[key]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** Truncate a string to maxLen chars, appending ellipsis if cut. */
function trunc(s: string, maxLen = 60): string {
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s
}

function patchFileCount(patchText: string): number {
  const paths = parsePatchText(patchText).flatMap((diff) => (
    diff.moveTo ? [diff.path, diff.moveTo] : [diff.path]
  ))
  return new Set(paths).size
}

function actionList(parsed: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(parsed.actions)
    ? (parsed.actions as unknown[]).filter((item): item is Record<string, unknown> => (
        typeof item === 'object' && item !== null && !Array.isArray(item)
      ))
    : []
}

function formatTodoAction(action: Record<string, unknown>): string {
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
  return type ? `${type} ${taskId ?? ''}`.trim() : JSON.stringify(action)
}

function formatSchedule(parsed: Record<string, unknown>): string | null {
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

const HIDE_ARGS_TOOLS = new Set([
  'read',
  'web_search',
  'web_fetch',
  'rm',
  'ls',
  'glob',
  'grep',
  'team_manage',
  'bg',
  'skill',
])

export function getToolDisplay(name: string, args: string | undefined): ToolDisplay {
  // ── date: no args, no args section ────────────────────────────────
  if (name === 'date') {
    return { header: null, headerTitle: null, formattedArgs: null }
  }

  if (!args) {
    // recall with no args — conversational header, no args section
    if (name === 'recall') {
      return { header: 'Checking memory…', headerTitle: 'Checking memory…', formattedArgs: null }
    }
    // team_message with no args — pending header so the start phase is
    // visible (otherwise tool_call → tool_start arrives so fast the
    // pending card flashes for <50ms and looks like only 2 phases run).
    if (name === 'team_message') {
      return { header: 'Preparing message…', headerTitle: 'Preparing message…', formattedArgs: null }
    }
    return { header: null, headerTitle: null, formattedArgs: null }
  }

  let parsed: Record<string, unknown>
  let isComplete = false
  try {
    parsed = JSON.parse(args)
    isComplete = true
  } catch {
    parsed = parsePartialJSON(args)
  }

  const resultDisplay = getToolDisplayInternal(name, parsed)
  if (!isComplete) {
    const shouldHideArgs = HIDE_ARGS_TOOLS.has(name)
    return {
      ...resultDisplay,
      formattedArgs: shouldHideArgs ? null : args,
    }
  }
  return resultDisplay
}

function getToolDisplayInternal(name: string, parsed: Record<string, unknown>): ToolDisplay {
  // ── shell: description as header, command as bash block ─────────────
  if (name === 'shell') {
    const description = str(parsed, 'description')
    return {
      header: description ? <Arg>{description}</Arg> : null,
      headerTitle: description,
      formattedArgs: str(parsed, 'command'),
      language: 'bash',
    }
  }

  // ── web_search: conversational header with query ───────────────────
  if (name === 'web_search') {
    const query = str(parsed, 'query')
    const truncated = query ? trunc(query) : null
    return {
      header: truncated ? <Arg>"{truncated}"</Arg> : null,
      headerTitle: truncated ? `"${truncated}"` : null,
      formattedArgs: null,
    }
  }

  // ── web_fetch: conversational header with domain ───────────────────
  if (name === 'web_fetch') {
    const url = str(parsed, 'url')
    let domain: string | null = null
    if (url) {
      try {
        domain = new URL(url.startsWith('http') ? url : `https://${url}`)
          .hostname.replace(/^www\./, '')
      } catch {
        domain = url
      }
    }
    const truncated = domain ? trunc(domain) : null
    return {
      header: truncated ? <Arg>{truncated}</Arg> : null,
      headerTitle: truncated ? truncated : null,
      formattedArgs: null,
    }
  }

  // ── remember: conversational header, list of [category] key: value ──
  if (name === 'remember') {
    const items = Array.isArray(parsed.items) ? parsed.items as Record<string, unknown>[] : []
    const lines = items.map((it) => {
      const cat = typeof it.category === 'string' ? it.category : ''
      const k = typeof it.key === 'string' ? it.key : ''
      const v = typeof it.value === 'string' ? it.value : ''
      return `[${cat}] ${k}: ${v}`
    })
    return {
      header: 'Saving to memory…',
      headerTitle: 'Saving to memory…',
      formattedArgs: lines.length > 0 ? lines.join('\n') : null,
    }
  }

  // ── forget: conversational header, list of category: key ──────────
  if (name === 'forget') {
    const items = Array.isArray(parsed.items) ? parsed.items as Record<string, unknown>[] : []
    const lines = items.map((it) => {
      const cat = typeof it.category === 'string' ? it.category : ''
      const k = typeof it.key === 'string' ? it.key : null
      return k ? `${cat}: ${k}` : cat
    })
    return {
      header: 'Removing from memory…',
      headerTitle: 'Removing from memory…',
      formattedArgs: lines.length > 0 ? lines.join('\n') : null,
    }
  }

  // ── recall: conversational header, filter as args ──────────────────
  if (name === 'recall') {
    const category = str(parsed, 'category')
    const key = str(parsed, 'key')
    const filter = [category, key].filter(Boolean).join(': ')
    return {
      header: 'Checking memory…',
      headerTitle: 'Checking memory…',
      formattedArgs: filter || null,
    }
  }

  // ── bg: action-based header, hide raw JSON ────────
  if (name === 'bg') {
    const action = str(parsed, 'action')?.toLowerCase()
    const pid = parsed['pid'] != null ? String(parsed['pid']) : null
    let header: ReactNode
    let headerTitle: string
    switch (action) {
      case 'list':
        header = 'Listing background processes…'
        headerTitle = 'Listing background processes…'
        break
      case 'status':
        if (pid) {
          header = <>Checking process <Arg>{pid}</Arg>…</>
          headerTitle = `Checking process ${pid}…`
        } else {
          header = 'Checking process status…'
          headerTitle = 'Checking process status…'
        }
        break
      case 'output':
        if (pid) {
          header = <>Reading output of process <Arg>{pid}</Arg>…</>
          headerTitle = `Reading output of process ${pid}…`
        } else {
          header = 'Reading process output…'
          headerTitle = 'Reading process output…'
        }
        break
      case 'wait':
        if (pid) {
          header = <>Waiting for process <Arg>{pid}</Arg>…</>
          headerTitle = `Waiting for process ${pid}…`
        } else {
          header = 'Waiting for process…'
          headerTitle = 'Waiting for process…'
        }
        break
      case 'stop':
        if (pid) {
          header = <>Stopping process <Arg>{pid}</Arg>…</>
          headerTitle = `Stopping process ${pid}…`
        } else {
          header = 'Stopping process…'
          headerTitle = 'Stopping process…'
        }
        break
      default:
        if (action) {
          header = <>bg: <Arg>{action}</Arg></>
          headerTitle = `bg: ${action}`
        } else {
          header = 'Managing background process…'
          headerTitle = 'Managing background process…'
        }
    }
    return { header, headerTitle, formattedArgs: null }
  }

  // ── skill: conversational header, result body shown on expand ──
  if (name === 'skill') {
    const skillName = str(parsed, 'skill_name')
    return {
      header: skillName ? <Arg>{skillName}</Arg> : null,
      headerTitle: skillName ? skillName : null,
      formattedArgs: null,
    }
  }

  // ── note: conversational header, note body as args ─────────────
  if (name === 'note') {
    return {
      header: 'Recording note…',
      headerTitle: 'Recording note…',
      formattedArgs: str(parsed, 'content'),
    }
  }

  // ── todo_manage: action summary in header, simplified action list ─
  if (name === 'todo_manage') {
    const actions = actionList(parsed)
    const first = actions[0]
    const firstAction = first ? str(first, 'action') : null
    if (actions.length === 1 && firstAction === 'read') {
      return { header: 'Reading todos…', headerTitle: 'Reading todos…', formattedArgs: null }
    }
    if (actions.length === 1 && firstAction === 'claim') {
      const taskId = str(first, 'task_id')
      return {
        header: taskId ? <>Claiming todo <Arg>{taskId}</Arg></> : 'Claiming todo…',
        headerTitle: taskId ? `Claiming todo ${taskId}` : 'Claiming todo…',
        formattedArgs: null,
      }
    }
    if (actions.length === 1 && firstAction === 'delete') {
      const taskId = str(first, 'task_id')
      return {
        header: taskId ? <>Deleting todo <Arg>{taskId}</Arg></> : 'Deleting todo…',
        headerTitle: taskId ? `Deleting todo ${taskId}` : 'Deleting todo…',
        formattedArgs: null,
      }
    }
    if (actions.length === 1 && firstAction === 'create') {
      const content = str(first, 'content')
      const truncated = content ? trunc(content) : null
      return {
        header: truncated ? <>Creating todo: <Arg>{truncated}</Arg></> : 'Creating todo…',
        headerTitle: truncated ? `Creating todo: ${truncated}` : 'Creating todo…',
        formattedArgs: formatTodoAction(first),
      }
    }
    if (actions.length === 1 && firstAction === 'update') {
      const taskId = str(first, 'task_id')
      return {
        header: taskId ? <>Updating todo <Arg>{taskId}</Arg></> : 'Updating todo…',
        headerTitle: taskId ? `Updating todo ${taskId}` : 'Updating todo…',
        formattedArgs: formatTodoAction(first),
      }
    }
    if (actions.length > 1) {
      return {
        header: <>Updating <Arg>{actions.length} todos</Arg>…</>,
        headerTitle: `Updating ${actions.length} todos…`,
        formattedArgs: actions.map(formatTodoAction).join('\n'),
      }
    }
    return { header: 'Managing todos…', headerTitle: 'Managing todos…', formattedArgs: null }
  }

  // ── schedule_task: action summary in header, prompt/schedule as args ─
  if (name === 'schedule_task') {
    const action = str(parsed, 'action')
    const taskName = str(parsed, 'name')
    const taskId = str(parsed, 'task_id')
    if (action === 'list') {
      return { header: 'Listing scheduled tasks…', headerTitle: 'Listing scheduled tasks…', formattedArgs: null }
    }
    if (action === 'create') {
      const truncated = taskName ? trunc(taskName) : null
      return {
        header: truncated ? <>Scheduling <Arg>{truncated}</Arg></> : 'Scheduling task…',
        headerTitle: truncated ? `Scheduling ${truncated}` : 'Scheduling task…',
        formattedArgs: formatSchedule(parsed),
      }
    }
    if (action === 'pause' || action === 'resume' || action === 'delete' || action === 'trigger') {
      const verb = action === 'pause'
        ? 'Pausing'
        : action === 'resume'
          ? 'Resuming'
          : action === 'delete'
            ? 'Deleting'
            : 'Triggering'
      return {
        header: taskId ? <>{verb} scheduled task <Arg>{taskId}</Arg></> : `${verb} scheduled task…`,
        headerTitle: taskId ? `${verb} scheduled task ${taskId}` : `${verb} scheduled task…`,
        formattedArgs: null,
      }
    }
    return { header: 'Managing scheduled tasks…', headerTitle: 'Managing scheduled tasks…', formattedArgs: null }
  }

  // ── write: file name in header, content as args ───────────────────
  if (name === 'write') {
    const path = str(parsed, 'path')
    const fileName = path ? pathBasename(path) : null
    const content = str(parsed, 'content')
    return {
      header: fileName ? <Arg>{fileName}</Arg> : 'file',
      headerTitle: fileName ? fileName : 'file',
      formattedArgs: summarizeText('content', content),
    }
  }

  // ── read: file name in header, custom result renderer shows content ──
  if (name === 'read') {
    const path = str(parsed, 'path')
    const fileName = path ? pathBasename(path) : null
    return {
      header: fileName ? <Arg>{fileName}</Arg> : 'file',
      headerTitle: fileName ? fileName : 'file',
      formattedArgs: null,
      suppressResult: true,
    }
  }

  // ── patch: all touched paths in header, full envelope as args ─────
  if (name === 'patch') {
    const patchText = str(parsed, 'patch_text')
    const fileCount = patchText ? patchFileCount(patchText) : 0
    const summary = fileCount > 0 ? `${fileCount} file${fileCount === 1 ? '' : 's'}` : null
    return {
      header: summary ? <Arg>{summary}</Arg> : 'patch',
      headerTitle: summary ?? 'patch',
      formattedArgs: patchText,
    }
  }

  // ── edit: file name in header, args as-is ─────────────────────────
  if (name === 'edit') {
    const path = str(parsed, 'path')
    const fileName = path ? pathBasename(path) : null
    return {
      header: fileName ? <Arg>{fileName}</Arg> : 'file',
      headerTitle: fileName ? fileName : 'file',
      formattedArgs: JSON.stringify(parsed, null, 2),
    }
  }

  // ── rm: file name in header, hide args ────────────────────────────
  if (name === 'rm') {
    const path = str(parsed, 'path')
    const fileName = path ? pathBasename(path) : null
    return {
      header: fileName ? <Arg>{fileName}</Arg> : 'file',
      headerTitle: fileName ? fileName : 'file',
      formattedArgs: null,
    }
  }

  // ── ls: directory path in header, hide args ───────────────────────
  // Default path is "." (workspace root) — elide that in the header
  // rather than saying "Listing ." which is noise.
  if (name === 'ls') {
    const path = str(parsed, 'path')
    const isRoot = !path || path === '.' || path === './'
    if (isRoot) {
      return { header: 'Listing workspace', headerTitle: 'Listing workspace', formattedArgs: null }
    }
    const truncated = trunc(path)
    return {
      header: <>Listing <Arg>{truncated}</Arg></>,
      headerTitle: `Listing ${truncated}`,
      formattedArgs: null,
    }
  }

  // ── glob: pattern in header, hide redundant args ─────
  if (name === 'glob') {
    const pattern = str(parsed, 'pattern')
    const directory = str(parsed, 'directory')
    const match = str(parsed, 'match')
    const hasScope = directory && directory !== '.' && directory !== './'
    const scope = hasScope ? ` in ${directory}` : ''
    const modeSuffix = match === 'name' ? ' (by name)' : ''
    const truncatedPattern = pattern ? trunc(pattern) : null
    return {
      header: truncatedPattern
        ? <>Finding <Arg>{truncatedPattern}</Arg>{scope}{modeSuffix}</>
        : 'Finding files…',
      headerTitle: truncatedPattern
        ? `Finding ${truncatedPattern}${scope}${modeSuffix}`
        : 'Finding files…',
      formattedArgs: null,
    }
  }

  // ── grep: pattern in header, hide redundant args ───
  if (name === 'grep') {
    const pattern = str(parsed, 'pattern')
    const directory = str(parsed, 'directory')
    const include = str(parsed, 'include')
    const hasScope = directory && directory !== '.' && directory !== './'
    const scope = hasScope ? ` in ${directory}` : ''
    const hasFilter = include && include !== '*'
    const filter = hasFilter ? ` (${include})` : ''
    const truncatedPattern = pattern ? trunc(pattern) : null
    return {
      header: truncatedPattern
        ? <>Searching <Arg>{truncatedPattern}</Arg>{scope}{filter}</>
        : 'Searching files…',
      headerTitle: truncatedPattern
        ? `Searching ${truncatedPattern}${scope}${filter}`
        : 'Searching files…',
      formattedArgs: null,
    }
  }

  // ── generate_image: filename in header, prompt as args, hide result ──
  // Result is the markdown ``![alt](file.png)`` which the assistant already
  // includes in its reply — rendering it again in the tool panel is noise.
  if (name === 'generate_image') {
    const prompt = str(parsed, 'prompt')
    const rawFilename = str(parsed, 'filename')
    // Strip any trailing extension to match backend sanitiser (which always saves as .png).
    const filename = rawFilename ? `${rawFilename.replace(/\.[^.]+$/, '')}.png` : null
    // Edit-mode inputs: list the source filenames above the prompt so the
    // user can tell the agent is editing vs. generating from scratch.
    const images = Array.isArray(parsed.images)
      ? (parsed.images as unknown[]).map(String).filter((s) => s.length > 0)
      : []
    const argsBody = images.length > 0
      ? `images: ${images.join(', ')}\n\n${prompt}`
      : prompt
    return {
      header: filename
        ? <>Painting <Arg>{filename}</Arg></>
        : 'Painting an image…',
      headerTitle: filename ? `Painting ${filename}` : 'Painting an image…',
      formattedArgs: argsBody,
      suppressResult: true,
    }
  }

  // ── generate_video: filename in header, prompt + inputs as args, hide result ──
  // Mirrors generate_image — the final ``![alt](clip.mp4)`` markdown is already
  // rendered inline by the assistant reply via MarkdownVideo, so repeating it
  // in the tool result accordion would just duplicate the player.
  if (name === 'generate_video') {
    const prompt = str(parsed, 'prompt')
    const rawFilename = str(parsed, 'filename')
    // Backend always writes .mp4 today; show the sanitised name for parity
    // with generate_image so the user sees the final on-disk filename.
    const filename = rawFilename ? `${rawFilename.replace(/\.[^.]+$/, '')}.mp4` : null
    const firstFrame = str(parsed, 'first_frame')
    const lastFrame = str(parsed, 'last_frame')
    const references = Array.isArray(parsed.reference_images)
      ? (parsed.reference_images as unknown[]).map(String).filter((s) => s.length > 0)
      : []
    const extendVideo = str(parsed, 'extend_video')
    const inputLines: string[] = []
    if (extendVideo) inputLines.push(`extend_video: ${extendVideo}`)
    if (firstFrame) inputLines.push(`first_frame: ${firstFrame}`)
    if (lastFrame) inputLines.push(`last_frame: ${lastFrame}`)
    if (references.length > 0) inputLines.push(`references: ${references.join(', ')}`)
    const argsBody = inputLines.length > 0
      ? `${inputLines.join('\n')}\n\n${prompt}`
      : prompt
    return {
      header: extendVideo
        ? (filename ? <>Extending <Arg>{filename}</Arg></> : 'Extending a video…')
        : (filename ? <>Filming <Arg>{filename}</Arg></> : 'Filming a video…'),
      headerTitle: extendVideo
        ? (filename ? `Extending ${filename}` : 'Extending a video…')
        : (filename ? `Filming ${filename}` : 'Filming a video…'),
      formattedArgs: argsBody,
      suppressResult: true,
    }
  }

  // ── team_message: recipients as header, message body as args ─────────
  if (name === 'team_message') {
    const to = Array.isArray(parsed.to) ? (parsed.to as unknown[]).map(String) : []
    const content = str(parsed, 'content')
    const recipientLabel = to.length > 0 ? to.join(', ') : 'team'
    const truncated = trunc(recipientLabel)
    return {
      header: <>Messaging <Arg>{truncated}</Arg></>,
      headerTitle: `Messaging ${truncated}`,
      formattedArgs: content,
    }
  }

  // ── team_manage: roster action in header, hide redundant args ───────
  if (name === 'team_manage') {
    const action = str(parsed, 'action')
    const members = Array.isArray(parsed.members)
      ? (parsed.members as unknown[]).map(String).filter(Boolean)
      : []
    const memberLabel = members.length > 0 ? members.join(', ') : 'team'
    const truncated = trunc(memberLabel)
    if (action === 'spawn') {
      return {
        header: <>Spawning <Arg>{truncated}</Arg></>,
        headerTitle: `Spawning ${truncated}`,
        formattedArgs: null,
      }
    }
    if (action === 'dismiss') {
      return {
        header: <>Dismissing <Arg>{truncated}</Arg></>,
        headerTitle: `Dismissing ${truncated}`,
        formattedArgs: null,
      }
    }
    if (action === 'list') {
      return {
        header: 'Listing team roster…',
        headerTitle: 'Listing team roster…',
        formattedArgs: null,
      }
    }
    return {
      header: 'Managing team roster…',
      headerTitle: 'Managing team roster…',
      formattedArgs: null,
    }
  }

  // ── Default: tool name as header, pretty-printed JSON as args ──────
  // Hide args entirely if the object is empty.
  if (Object.keys(parsed).length === 0) {
    return { header: null, headerTitle: null, formattedArgs: null }
  }
  return { header: null, headerTitle: null, formattedArgs: JSON.stringify(parsed, null, 2) }
}
