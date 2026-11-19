import type { ScriptRunSummary } from '@/api/types'

/**
 * The summary a `script` call's row shows while its result stays on the
 * server, as `tool_end` metadata and history rows carry it (`script_run`,
 * `appv3_db::api::script_run`). `undefined` for anything else.
 */
export function scriptRunOf(value: unknown): ScriptRunSummary | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { calls, saved, stopped } = value as Record<string, unknown>
  if (typeof calls !== 'number' || !Number.isInteger(calls) || calls < 0) return undefined
  return {
    calls,
    ...(typeof saved === 'string' && saved ? { saved } : {}),
    ...(stopped === true ? { stopped: true } : {}),
  }
}
