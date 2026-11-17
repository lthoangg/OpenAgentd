/**
 * `oauth-done.html`: where the relay page sends a connector's sign-in code
 * in a browser on another device. Hands it to the server with this
 * browser's access key, says how it went, and closes when it can.
 */
import { installDesktopAuth } from '@/api/auth'
import { finishSignInFromPage } from './finish'

installDesktopAuth()

const title = document.getElementById('title')
const detail = document.getElementById('detail')

void finishSignInFromPage(window.location.search).then(({ ok, title: t, detail: d }) => {
  if (title) title.textContent = t
  if (detail) detail.textContent = d
  if (ok) setTimeout(() => window.close(), 1500)
})
// The code is single-use, but keep it out of the history anyway.
window.history.replaceState(null, '', window.location.pathname)
