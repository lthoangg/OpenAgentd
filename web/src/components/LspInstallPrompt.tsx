/**
 * The TypeScript tools prompt: one line in the notices column, the same
 * shape as the update notice. Done leaves a toast; a failure says why in a
 * toast and keeps the line, with Retry. It is a status line, not a dialog:
 * nothing takes focus, and it is announced politely when it appears.
 */
import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

import { apiBaseUrl } from '@/api/base-url'
import { installTypeScriptLsp } from '@/api/client'
import { NoticeLine } from '@/components/NoticeLine'
import { Button } from '@/components/ui/button'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { failureToast } from '@/lib/failure-toast'
import { noticePresence } from '@/lib/motion'
import { useLspInstallStore } from '@/stores/useLspInstallStore'
import type { LspInstallRequest } from '@/stores/useLspInstallStore'
import { useToastStore } from '@/stores/useToastStore'
import { workspaceLabel } from '@/utils/workspace'

const FAILED = "Couldn't install TypeScript tools"

export function LspInstallPrompt() {
  const request = useLspInstallStore((state) => state.request)
  const reduced = useReducedMotion() ?? false
  const requestKey = request
    ? `${apiBaseUrl()}\0${request.workspace}\0${request.languageServerVersion}\0${request.typeScriptVersion}`
    : null
  return (
    <AnimatePresence>
      {request && requestKey && (
        <motion.div key={requestKey} className="pointer-events-none w-full" {...noticePresence(reduced)}>
          <LspInstallLine request={request} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function LspInstallLine({ request }: { request: LspInstallRequest }) {
  const dismiss = useLspInstallStore((state) => state.dismiss)
  const [failed, setFailed] = useState(false)
  const [installing, setInstalling] = useState(false)
  const name = workspaceLabel(request.workspace)

  const install = async () => {
    const push = useToastStore.getState().push
    setInstalling(true)
    try {
      const status = await installTypeScriptLsp()
      if (status.typescript.state === 'error') {
        setFailed(true)
        push(failureToast(FAILED, status.typescript.detail))
      } else if (status.typescript.state !== 'ready') {
        setFailed(true)
        push({ tone: 'error', title: FAILED, description: 'The install did not finish. Retry, or check the logs of the computer the agent runs on.' })
      } else {
        push({ tone: 'success', title: 'TypeScript tools are ready', description: name })
        dismiss(request)
      }
    } catch (cause) {
      setFailed(true)
      push(failureToast(FAILED, cause))
    } finally {
      setInstalling(false)
    }
  }

  return (
    <aside className="pointer-events-none flex w-full justify-end">
      {installing ? (
        <NoticeLine aria-label="Install TypeScript language tools" busy text="Installing TypeScript tools…" />
      ) : (
        <NoticeLine
          aria-label="Install TypeScript language tools"
          text={`Install TypeScript tools for ${name}?`}
          detail={`Downloaded and installed on the computer the agent runs on, not on this device.\n${request.workspace}\nLanguage server ${request.languageServerVersion}, TypeScript ${request.typeScriptVersion}`}
        >
          <Button type="button" variant="ghost" size="xs" onClick={() => dismiss(request)}>Later</Button>
          <Button type="button" variant="primary" size="xs" onClick={() => { void install() }}>{failed ? 'Retry' : 'Install'}</Button>
        </NoticeLine>
      )}
    </aside>
  )
}
