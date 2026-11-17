import { codeFromReturn, deliverSignInCode, serverFromState } from '@/lib/mcp-sign-in'
import { errorMessage } from '@/utils/errors'

export interface FinishResult {
  ok: boolean
  title: string
  detail: string
}

/** Finish the sign-in a returned address (`?code=…&state=…`) carries. */
export async function finishSignInFromPage(search: string): Promise<FinishResult> {
  const returned = codeFromReturn(new URLSearchParams(search))
  if (!returned) return { ok: false, title: 'Nothing to finish', detail: 'This page has no sign-in code. Start the sign-in again from OpenAgentd.' }
  const label = serverFromState(returned.state) ?? 'the connector'
  try {
    await deliverSignInCode(returned)
    return { ok: true, title: `Signed in to ${label}`, detail: 'You can close this window and go back to OpenAgentd.' }
  } catch (err) {
    return { ok: false, title: `Couldn't sign in to ${label}`, detail: errorMessage(err) }
  }
}
