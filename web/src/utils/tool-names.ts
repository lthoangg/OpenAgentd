/**
 * Former names of renamed tools (``appv3_tools::TOOL_ALIASES``). Transcripts
 * saved before the rename keep the old name, so name checks go through
 * {@link canonicalToolName} and both render and refresh alike.
 */
const FORMER_TOOL_NAMES: Record<string, string> = {
  todo_manage: 'todo',
  schedule_task: 'schedule',
  send_to_workspace: 'workspace',
  delegate: 'team',
}

/** The current name for `name`, which may be a tool's former name. */
export function canonicalToolName(name: string): string {
  return Object.hasOwn(FORMER_TOOL_NAMES, name) ? FORMER_TOOL_NAMES[name] : name
}

/**
 * Whether a tool call submits the session plan for review: ``plan`` with
 * ``submit: true``, or the former ``submit_plan`` tool that old transcripts
 * hold. The raw arguments are matched, so a call still streaming counts as
 * soon as the flag arrives; a ``"submit"`` inside the plan text is escaped
 * and does not match.
 */
export function isPlanSubmission(name: string | undefined, args: string | undefined): boolean {
  if (name === 'submit_plan') return true
  return name === 'plan' && /"submit"\s*:\s*(?:true|"true")/.test(args ?? '')
}

/** Actions that change OpenAgentd's setup, per tool (``appv3_agent::confirm::opens``). */
const CONFIRMING_ACTIONS: Record<string, readonly string[]> = {
  mcp: ['save', 'remove'],
  workspace: ['set_groups'],
}

/**
 * Whether a tool call asks the user to confirm a change on a card (an MCP
 * server, a repository's workspace groups) instead of applying it. Only the
 * top-level ``action`` counts; arguments still streaming count once it has
 * arrived.
 */
export function opensConfirmation(name: string | undefined, args: string | undefined): boolean {
  const actions = name ? CONFIRMING_ACTIONS[canonicalToolName(name)] : undefined
  if (!actions || !args) return false
  let action: unknown
  try {
    action = (JSON.parse(args) as { action?: unknown } | null)?.action
  } catch {
    // Streaming: the first "action" key is the top-level one, since the tool's
    // schema lists it first and the model writes it first.
    action = /^\s*\{\s*"action"\s*:\s*"([^"]*)"/.exec(args)?.[1]
  }
  return typeof action === 'string' && actions.includes(action.trim())
}
