import { WifiOff } from 'lucide-react'
import type { UnreachableServer } from '@/island/status'
import { MAX_ROWS, type TraySession, type TraySessions, rowSubtitle } from './sessions'

/**
 * What needs the user, and what runs, from the same feed the notch and the
 * pet read. A row opens its session in the window that shows it.
 */
export function SessionList({ sessions, onOpen, onRetry }: {
  sessions: TraySessions
  onOpen: (sessionId: string) => void
  onRetry: () => void
}) {
  const { needsYou, running, unreachable } = sessions
  if (needsYou.length === 0 && running.length === 0 && unreachable.length === 0) return null
  return (
    <div className="sessions">
      <Group title="Needs you" tone="needs" rows={needsYou} onOpen={onOpen} action="Open" />
      <Group title="Running" tone="running" rows={running} onOpen={onOpen} />
      {unreachable.length > 0 && (
        <section className="group" aria-label="Can't reach">
          <h2 className="group-title">Can't reach</h2>
          <ul className="group-rows">
            {unreachable.map((server) => <ServerLine key={server.id} server={server} onRetry={onRetry} />)}
          </ul>
        </section>
      )}
    </div>
  )
}

function Group({ title, tone, rows, onOpen, action }: {
  title: string
  tone: 'needs' | 'running'
  rows: TraySession[]
  onOpen: (sessionId: string) => void
  /** A word on the row that says what a click does (waiting rows only). */
  action?: string
}) {
  if (rows.length === 0) return null
  const shown = rows.slice(0, MAX_ROWS)
  return (
    <section className="group" aria-label={title}>
      <h2 className="group-title">
        {title}
        <span className="group-count">{rows.length}</span>
      </h2>
      <ul className="group-rows">
        {shown.map((session) => (
          <li key={session.id}>
            <button type="button" className="session-row" onClick={() => onOpen(session.id)}>
              <span className="session-dot" data-tone={tone} aria-hidden="true" />
              <span className="session-text">
                <span className="session-title">{session.title}</span>
                <span className="session-sub">{rowSubtitle(session)}</span>
              </span>
              {action && <span className="session-go">{action}</span>}
            </button>
          </li>
        ))}
      </ul>
      {rows.length > shown.length && <p className="group-more">{rows.length - shown.length} more in OpenAgentd</p>}
    </section>
  )
}

function ServerLine({ server, onRetry }: { server: UnreachableServer; onRetry: () => void }) {
  return (
    <li className="session-row session-row--static">
      <WifiOff size={14} strokeWidth={2} aria-hidden="true" className="session-mark" />
      <span className="session-text">
        <span className="session-title">{server.name}</span>
        <span className="session-sub">{server.reason === 'key_rejected' ? 'Access key rejected' : 'Not answering'}</span>
      </span>
      <button type="button" className="small-btn" onClick={onRetry} aria-label={`Retry ${server.name}`}>Retry</button>
    </li>
  )
}
