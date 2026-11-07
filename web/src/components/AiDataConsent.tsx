/**
 * AiDataConsent — on the iOS app, asks once, before anything can be sent,
 * for consent to share what the user writes with the AI providers their
 * server uses (App Review guideline 5.1.2(i): name the data, who gets it,
 * and get permission first). It cannot be dismissed without agreeing; the
 * answer is kept on the device.
 */
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { getPlatform } from '@/hooks/use-platform'
import { openExternalUrl } from '@/lib/open-external'

export const AI_CONSENT_KEY = 'oad.ai-data-consent.v1'
export const PRIVACY_URL = 'https://openagentd.dev/privacy/#ios-app'

function needsConsent(): boolean {
  const { isTauri, os } = getPlatform()
  if (!isTauri || os !== 'ios') return false
  try {
    return localStorage.getItem(AI_CONSENT_KEY) !== 'agreed'
  } catch {
    return true
  }
}

export function AiDataConsent() {
  const [open, setOpen] = useState(needsConsent)

  function agree() {
    try {
      localStorage.setItem(AI_CONSENT_KEY, 'agreed')
    } catch {
      // Private storage off: ask again next launch.
    }
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} alert={false} aria-describedby="ai-consent-body">
        <DialogHeader>
          <DialogTitle>Your messages go to AI providers</DialogTitle>
          <DialogDescription id="ai-consent-body">
            OpenAgentd sends what you write, the files and photos you attach, and the code
            your agents read to your OpenAgentd server. The server forwards them to the AI
            providers you set up on it, such as OpenAI, Anthropic, Google or a local model,
            to answer you. They handle that data under their own privacy policies. This app
            itself collects nothing and does not track you.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="default" onClick={() => void openExternalUrl(PRIVACY_URL)}>
            Privacy policy
          </Button>
          <Button variant="primary" onClick={agree}>
            Agree and continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
