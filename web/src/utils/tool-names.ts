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
