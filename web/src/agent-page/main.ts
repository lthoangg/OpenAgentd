// The desktop app's hidden window for a page the agent uses while no app
// window is open. Framed, the page's injected script polls the server for
// the agent's commands, as in an app window's hidden frame.
import { AGENT_PAGE_SANDBOX, agentPageSrc } from './frame-src'

const src = agentPageSrc(window.location.search)
if (src) {
  const frame = document.createElement('iframe')
  frame.title = 'Agent page'
  frame.src = src
  frame.setAttribute('sandbox', AGENT_PAGE_SANDBOX)
  document.body.append(frame)
} else {
  document.body.textContent = 'This window only shows a page served on this computer.'
}
