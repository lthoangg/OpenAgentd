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


import type { ReactNode } from 'react'
import type { ToolDisplay } from './types'
import { patchFiles } from './diffUtils'
import { pathBasename } from '@/utils/workspace'
import { parsePartialJSON } from './displayText'
import { canonicalToolName } from '@/utils/tool-names'
import { scriptSource } from './scriptTrace'
import { secretHeaderLabel } from './secretArgs'
import {
  str,
  trunc,
  cutFull,
  mcpArguments,
  shortUrl,
  patchPaths,
  actionList,
  formatTodoAction,
  clearScope,
  formatSchedule,
  planDisplay,
  previewPageActionLabel,
  previewChainLabel,
} from './displayArgs'

/**
 * Keep argument values in headers easy to restyle consistently.
 */
function Arg({ children }: { children: ReactNode }) {
  return <span>{children}</span>
}

const HIDE_ARGS_TOOLS = new Set([
  'read',
  'web_search',
  'web_fetch',
  'glob',
  'grep',
  'bg',
  'skill',
])

/**
 * The row's target after the tool name. Worded to read the same while the
 * call runs and after it finishes (`list`, `add "Add tests"`, a path, a
 * command): the result summary, not the header, says how it went.
 */
export function getToolDisplay(rawName: string, args: string | undefined): ToolDisplay {
  const name = canonicalToolName(rawName)
  if (!args) {
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

  const resultDisplay = name === 'plan' ? planDisplay(parsed) : getToolDisplayInternal(name, parsed)
  // A streaming plan reads better as its partial Markdown than as raw JSON.
  if (!isComplete && name !== 'plan') {
    const shouldHideArgs = HIDE_ARGS_TOOLS.has(name)
    return {
      ...resultDisplay,
      formattedArgs: shouldHideArgs ? null : args,
    }
  }
  return resultDisplay
}

function getToolDisplayInternal(name: string, parsed: Record<string, unknown>): ToolDisplay {
  // ── script: its description, or the saved script it runs; the open row
  //    shows the code (ScriptView) ───
  if (name === 'script') {
    const title = str(parsed, 'description') ?? scriptSource(parsed)?.label ?? (parsed.list ? 'list saved scripts' : null)
    return {
      header: title ? <Arg>{trunc(title, 80)}</Arg> : null,
      headerTitle: title,
      formattedArgs: typeof parsed.code === 'string' ? parsed.code : null,
    }
  }

  // ── browser: the page it opens, the console it reads, or the page action ──
  if (name === 'browser') {
    const action = str(parsed, 'action')
    if (action === 'logs') {
      const label = str(parsed, 'level') === 'error' ? 'Console errors' : 'Console'
      return { header: <Arg>{label}</Arg>, headerTitle: label, formattedArgs: null }
    }
    if (action === 'chain') {
      const { short, full } = previewChainLabel(parsed)
      return { header: <Arg>{short}</Arg>, headerTitle: full, fullTarget: short === full ? null : full, formattedArgs: null }
    }
    const page = action ? previewPageActionLabel(action, parsed) : null
    if (page) return { header: <Arg>{page}</Arg>, headerTitle: page, formattedArgs: null }
    const url = str(parsed, 'url')
    const label = url ? shortUrl(url) : str(parsed, 'path')
    return { header: label ? <Arg>{label}</Arg> : null, headerTitle: label, formattedArgs: null }
  }

  // ── shell: the agent's description is the target, the command its
  //    bash block; without a description, the command ───
  if (name === 'shell') {
    const description = str(parsed, 'description')
    const command = str(parsed, 'command')
    const oneLine = command ? command.replace(/\s*\n\s*/g, ' ') : null
    return {
      header: description ? <Arg>{description}</Arg> : oneLine ? <Arg>{trunc(oneLine, 80)}</Arg> : null,
      headerTitle: description ?? oneLine,
      // The details show the command whole once known: a described call's
      // live event carries only the description, history has the command.
      formattedArgs: command,
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
      fullTarget: cutFull(query),
      formattedArgs: null,
    }
  }

  // ── lsp: operation-specific semantic navigation summary ───────────
  if (name === 'lsp') {
    const operation = str(parsed, 'operation')
    const path = str(parsed, 'path')
    const query = str(parsed, 'query')
    const kind = str(parsed, 'kind')
    const line = typeof parsed.line === 'number' ? parsed.line : 1
    const character = typeof parsed.character === 'number' ? parsed.character : 1
    const location = path ? `${path}:${line}:${character}` : null

    if (operation === 'go_to_definition') {
      const label = location ? `Definition at ${location}` : 'Definition'
      return {
        header: <Arg>{label}</Arg>,
        headerTitle: label,
        formattedArgs: path ? `file: ${path}\nposition: ${line}:${character}` : null,
      }
    }
    if (operation === 'find_references') {
      const label = location ? `References at ${location}` : 'References'
      return {
        header: <Arg>{label}</Arg>,
        headerTitle: label,
        formattedArgs: path ? `file: ${path}\nposition: ${line}:${character}` : null,
      }
    }
    if (operation === 'find_implementations') {
      const label = location ? `Implementations at ${location}` : 'Implementations'
      return {
        header: <Arg>{label}</Arg>,
        headerTitle: label,
        formattedArgs: path ? `file: ${path}\nposition: ${line}:${character}` : null,
      }
    }
    if (operation === 'hover') {
      const label = location ? `Hover at ${location}` : 'Hover'
      return {
        header: <Arg>{label}</Arg>,
        headerTitle: label,
        formattedArgs: path ? `file: ${path}\nposition: ${line}:${character}` : null,
      }
    }
    if (operation === 'document_symbol') {
      const kindPrefix = kind ? `${kind.charAt(0).toUpperCase()}${kind.slice(1)} symbols` : 'Symbols'
      const label = path ? `${kindPrefix} in ${path}` : (kind ? kindPrefix : 'Document symbols')
      return {
        header: <Arg>{label}</Arg>,
        headerTitle: label,
        formattedArgs: [path ? `file: ${path}` : null, kind ? `kind: ${kind}` : null]
          .filter(Boolean)
          .join('\n') || null,
      }
    }
    if (operation === 'workspace_symbol') {
      const queryLabel = query ? `"${trunc(query)}"` : 'all symbols'
      const kindSuffix = kind ? ` (${kind})` : ''
      const label = path
        ? `Workspace symbols ${queryLabel}${kindSuffix} via ${path}`
        : `Workspace symbols ${queryLabel}${kindSuffix}`
      return {
        header: <Arg>{label}</Arg>,
        headerTitle: label,
        formattedArgs: [
          query ? `query: ${query}` : null,
          kind ? `kind: ${kind}` : null,
          path ? `language file: ${path}` : null,
        ]
          .filter(Boolean)
          .join('\n') || null,
      }
    }
  }

  // ── web_fetch: conversational header with domain + path ────────────
  if (name === 'web_fetch') {
    const url = str(parsed, 'url')
    const label = url ? shortUrl(url) : null
    return {
      header: label ? <Arg>{trunc(label)}</Arg> : null,
      headerTitle: label,
      // A long location is cut in the row; the open row shows the URL
      // whole, as fetched (scheme and ``www`` included), for Copy.
      fullTarget: cutFull(label) ? url : null,
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
    const saved = items.length === 1 && typeof items[0].key === 'string' ? `"${items[0].key}"` : items.length > 1 ? `${items.length} items` : null
    return {
      header: saved ? <Arg>{saved}</Arg> : null,
      headerTitle: saved,
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
    const removed = lines.length === 1 ? `"${lines[0]}"` : lines.length > 1 ? `${lines.length} items` : null
    return {
      header: removed ? <Arg>{removed}</Arg> : null,
      headerTitle: removed,
      formattedArgs: lines.length > 0 ? lines.join('\n') : null,
    }
  }

  // ── recall: conversational header, filter as args ──────────────────
  if (name === 'recall') {
    const category = str(parsed, 'category')
    const key = str(parsed, 'key')
    const filter = [category, key].filter(Boolean).join(': ')
    return {
      header: filter ? <Arg>{`"${trunc(filter)}"`}</Arg> : null,
      headerTitle: filter ? `"${filter}"` : null,
      formattedArgs: filter || null,
    }
  }

  // ── bg: `pid 4312` plus the action, hide raw JSON ────────
  if (name === 'bg') {
    const action = str(parsed, 'action')?.toLowerCase()
    const pid = parsed['pid'] != null ? String(parsed['pid']) : null
    const label = [action, pid ? `pid ${pid}` : null].filter(Boolean).join(' ') || null
    return { header: label ? <Arg>{label}</Arg> : null, headerTitle: label, formattedArgs: null }
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
      header: null,
      headerTitle: null,
      formattedArgs: str(parsed, 'content'),
    }
  }

  // ── todo: the action as the target (`add "Add tests"`, `complete
  //    task_1`), worded so it reads the same running or finished ─────────
  if (name === 'todo') {
    const actions = actionList(parsed)
    const first = actions[0]
    const firstAction = first ? str(first, 'action') : null
    if (actions.length === 1 && firstAction === 'read') {
      return { header: <Arg>list</Arg>, headerTitle: 'list', formattedArgs: null }
    }
    if (actions.length === 1 && firstAction === 'clear') {
      const header = `clear ${clearScope(first)}`
      return { header: <Arg>{header}</Arg>, headerTitle: header, formattedArgs: null }
    }
    if (actions.length === 1 && firstAction === 'claim') {
      const taskId = str(first, 'task_id')
      return {
        header: <Arg>{taskId ? `claim ${taskId}` : 'claim'}</Arg>,
        headerTitle: taskId ? `claim ${taskId}` : 'claim',
        formattedArgs: null,
      }
    }
    if (actions.length === 1 && firstAction === 'delete') {
      const taskId = str(first, 'task_id')
      return {
        header: <Arg>{taskId ? `delete ${taskId}` : 'delete'}</Arg>,
        headerTitle: taskId ? `delete ${taskId}` : 'delete',
        formattedArgs: null,
      }
    }
    if (actions.length === 1 && firstAction === 'create') {
      const content = str(first, 'content')
      const truncated = content ? trunc(content) : null
      return {
        header: <Arg>{truncated ? `add "${truncated}"` : 'add'}</Arg>,
        headerTitle: truncated ? `add "${truncated}"` : 'add',
        formattedArgs: formatTodoAction(first),
      }
    }
    if (actions.length === 1 && firstAction === 'update') {
      const taskId = str(first, 'task_id')
      // Completion is the board's key transition (records the result and
      // wakes the agent and unblocked tasks) — label it precisely.
      const isCompleting = str(first, 'status') === 'completed'
      const verb = isCompleting ? 'complete' : 'update'
      return {
        header: <Arg>{taskId ? `${verb} ${taskId}` : verb}</Arg>,
        headerTitle: taskId ? `${verb} ${taskId}` : verb,
        formattedArgs: formatTodoAction(first),
      }
    }
    if (actions.length > 1) {
      return {
        header: <Arg>{`${actions.length} actions`}</Arg>,
        headerTitle: `${actions.length} actions`,
        formattedArgs: actions.map(formatTodoAction).join('\n'),
      }
    }
    return { header: null, headerTitle: null, formattedArgs: null }
  }

  // ── schedule: action summary in header, prompt/schedule as args ───
  if (name === 'schedule') {
    const action = str(parsed, 'action')
    const taskName = str(parsed, 'name')
    const taskId = str(parsed, 'task_id')
    if (action === 'list') {
      return { header: <Arg>list</Arg>, headerTitle: 'list', formattedArgs: null }
    }
    if (action === 'create') {
      const truncated = taskName ? trunc(taskName) : null
      return {
        header: <Arg>{truncated ? `create ${truncated}` : 'create'}</Arg>,
        headerTitle: truncated ? `create ${truncated}` : 'create',
        formattedArgs: formatSchedule(parsed),
      }
    }
    if (action === 'pause' || action === 'resume' || action === 'delete' || action === 'trigger') {
      return {
        header: <Arg>{taskId ? `${action} ${taskId}` : action}</Arg>,
        headerTitle: taskId ? `${action} ${taskId}` : action,
        formattedArgs: null,
      }
    }
    return { header: action ? <Arg>{action}</Arg> : null, headerTitle: action, formattedArgs: null }
  }

  // ── read: file name in header, custom result renderer shows content ──
  if (name === 'read') {
    const path = str(parsed, 'path')
    const fileName = path ? pathBasename(path) : null
    return {
      header: fileName ? <Arg>{fileName}</Arg> : 'file',
      headerTitle: path ?? 'file',
      formattedArgs: null,
      suppressResult: true,
    }
  }

  // ── patch: touched file names in header, full envelope as args ─────
  if (name === 'patch') {
    const patchText = str(parsed, 'patch_text')
    // History sends a patch short: its files, without the envelope.
    const paths = patchText
      ? patchPaths(patchText)
      : [...new Set(patchFiles(JSON.stringify(parsed)).flatMap((file) => (file.moveTo ? [file.path, file.moveTo] : [file.path])))]
    const names = [...new Set(paths.map(pathBasename))]
    const summary = names.length > 0 ? trunc(names.join(', ')) : null
    return {
      header: summary ? <Arg>{summary}</Arg> : 'patch',
      headerTitle: summary ?? 'patch',
      formattedArgs: patchText,
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
      header: truncatedPattern ? <Arg>{`${truncatedPattern}${scope}${modeSuffix}`}</Arg> : null,
      headerTitle: truncatedPattern ? `${truncatedPattern}${scope}${modeSuffix}` : null,
      fullTarget: cutFull(pattern),
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
      header: truncatedPattern ? <Arg>{`"${truncatedPattern}"${scope}${filter}`}</Arg> : null,
      headerTitle: truncatedPattern ? `"${truncatedPattern}"${scope}${filter}` : null,
      fullTarget: cutFull(pattern),
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
        ? <Arg>{filename}</Arg>
        : null,
      headerTitle: filename,
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
      header: filename ? <Arg>{extendVideo ? `extend ${filename}` : filename}</Arg> : extendVideo ? <Arg>extend</Arg> : null,
      headerTitle: filename ? (extendVideo ? `extend ${filename}` : filename) : extendVideo ? 'extend' : null,
      formattedArgs: argsBody,
      suppressResult: true,
    }
  }

  // ── Team and Subagent coordination tools ─────────────────────────
  if (name === 'team') {
    const profile = str(parsed, 'profile') || 'subagent'
    const target = str(parsed, 'target')
    const task = str(parsed, 'task')
    const action = str(parsed, 'action')
    if (action === 'list') {
      return { header: <Arg>list</Arg>, headerTitle: 'list', formattedArgs: null }
    }
    if (target && (action === 'stop' || action === 'interrupt')) {
      const verb = action === 'stop' ? 'stop' : 'interrupt'
      return {
        header: <>{verb} <Arg>{target}</Arg></>,
        headerTitle: `${verb} ${target}`,
        formattedArgs: action === 'stop' ? null : task,
      }
    }
    return {
      header: target ? <>send <Arg>{target}</Arg></> : <>spawn <Arg>{profile}</Arg></>,
      headerTitle: target ? `send ${target}` : `spawn ${profile}`,
      formattedArgs: task,
    }
  }

  // ── workspace: another workspace's agent session ──────────────────
  if (name === 'workspace') {
    const workspace = str(parsed, 'workspace')
    const label = workspace ? trunc(pathBasename(workspace) || workspace) : null
    if (str(parsed, 'action') === 'list') {
      return {
        header: <Arg>{label ? `list ${label}` : 'list'}</Arg>,
        headerTitle: label ? `list ${label}` : 'list',
        formattedArgs: null,
      }
    }
    const waits = parsed.reply === true ? ' · awaiting reply' : ''
    const worktree = str(parsed, 'worktree')
    const checkout = worktree ? (worktree.toLowerCase() === 'main' ? 'main workspace' : `worktree ${trunc(worktree)}`) : null
    if (checkout) {
      const where = label ? `${label} · ${checkout}` : checkout
      return {
        header: <>→ <Arg>{where}</Arg>{waits}</>,
        headerTitle: `→ ${where}${waits}`,
        formattedArgs: str(parsed, 'message'),
      }
    }
    const target = label ?? 'workspace'
    return {
      header: <>→ <Arg>{target}</Arg>{waits}</>,
      headerTitle: `→ ${target}${waits}`,
      formattedArgs: str(parsed, 'message'),
    }
  }

  if (name === 'secret') { // a request has its own card; this is its row
    const label = trunc(secretHeaderLabel(parsed))
    return { header: <Arg>{label}</Arg>, headerTitle: label, formattedArgs: null }
  }

  // ── mcp: one tool for every MCP server — search, or call server · tool ──
  if (name === 'mcp') {
    const server = str(parsed, 'server')
    if (str(parsed, 'action') === 'search') {
      const query = str(parsed, 'query')
      const q = query ? trunc(query) : null
      const title = q ? `Search MCP tools "${q}"${server ? ` in ${server}` : ''}` : server ? `List ${server} tools` : 'List MCP tools'
      const header = q
        ? <>Search MCP tools <Arg>"{q}"</Arg>{server ? <> in <Arg>{server}</Arg></> : null}</>
        : server ? <>List <Arg>{server}</Arg> tools</> : 'List MCP tools'
      return { header, headerTitle: title, formattedArgs: null }
    }
    const tool = str(parsed, 'tool')
    const label = server && tool ? `${server} · ${tool}` : tool ?? server
    return {
      header: label ? <Arg>{label}</Arg> : null,
      headerTitle: label,
      formattedArgs: mcpArguments(parsed.arguments),
    }
  }

  if (name === 'ask_lead') {
    const question = str(parsed, 'question')
    return {
      header: question ? <Arg>{`"${trunc(question, 50)}"`}</Arg> : null,
      headerTitle: question ? `Question for the main agent: ${question}` : null,
      formattedArgs: question,
    }
  }

  // ── Default: tool name as header, pretty-printed JSON as args ──────
  // Hide args entirely if the object is empty.
  if (Object.keys(parsed).length === 0) {
    return { header: null, headerTitle: null, formattedArgs: null }
  }
  return { header: null, headerTitle: null, formattedArgs: JSON.stringify(parsed, null, 2) }
}
