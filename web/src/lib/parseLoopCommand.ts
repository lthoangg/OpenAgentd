export type ParsedLoopCommand =
  | { kind: 'none' }
  | { kind: 'start'; prompt: string }
  | { kind: 'start_missing_prompt' }
  | { kind: 'set'; limit: number }
  | { kind: 'set_invalid_limit' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'stop' }
  | { kind: 'unknown_subcommand'; subcommand: string }

const LOOP_LIMITS = new Set([5, 10, 20, 50])

export function parseLoopCommand(content: string): ParsedLoopCommand {
  const trimmed = content.trim()
  if (trimmed === '/loop') return { kind: 'start_missing_prompt' }
  if (trimmed.startsWith('/loop ')) {
    const prompt = trimmed.slice('/loop '.length).trim()
    return prompt ? { kind: 'start', prompt } : { kind: 'start_missing_prompt' }
  }
  if (!trimmed.startsWith('/loop:')) return { kind: 'none' }

  const rest = trimmed.slice('/loop:'.length)
  const match = rest.match(/^(\S+)\s*([\s\S]*)$/)
  if (!match) return { kind: 'none' }

  const subcommand = match[1]
  const args = match[2].trim()
  switch (subcommand) {
    case 'set': {
      const limit = Number(args)
      return /^\d+$/.test(args) && LOOP_LIMITS.has(limit)
        ? { kind: 'set', limit }
        : { kind: 'set_invalid_limit' }
    }
    case 'pause':
      return args ? { kind: 'unknown_subcommand', subcommand } : { kind: 'pause' }
    case 'resume':
      return args ? { kind: 'unknown_subcommand', subcommand } : { kind: 'resume' }
    case 'stop':
      return args ? { kind: 'unknown_subcommand', subcommand } : { kind: 'stop' }
    default:
      return { kind: 'unknown_subcommand', subcommand }
  }
}
