/**
 * "Command finished": a command that ran a while in a terminal you are not
 * looking at (a build, a test run, an install) tells you when it is done,
 * with Show to bring that terminal up. Short commands and the terminal on
 * screen stay quiet. Only the open workspace's shells count, so Show always
 * lands in the dock you have. Unix only: Windows never reports busy.
 */
import { useEffect } from 'react'

import { getTerminalRuntime, onTerminalCommandFinished, useTerminalStore } from '@/stores/useTerminalStore'
import { useToastStore } from '@/stores/useToastStore'

/** Commands shorter than this finish too soon to be worth a notice. */
export const TERMINAL_FINISHED_NOTICE_MS = 10_000

export function useTerminalFinishedNotice(workspace: string | null | undefined, onShow: (id: string) => void): void {
  useEffect(() => {
    if (!workspace) return
    return onTerminalCommandFinished((id, durationMs) => {
      if (durationMs < TERMINAL_FINISHED_NOTICE_MS) return
      const meta = useTerminalStore.getState().sessions[id]
      if (!meta || meta.contextKey !== workspace) return
      if (getTerminalRuntime(id)?.attached) return
      useToastStore.getState().push({
        tone: 'info',
        title: `${meta.title} · Command finished`,
        action: { label: 'Show', onAction: () => onShow(id) },
      })
    })
  }, [workspace, onShow])
}
