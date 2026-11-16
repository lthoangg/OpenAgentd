import { useHealthQuery } from '@/queries'
import { PhoneStack } from '@/components/phone/PhoneStack'
import { ServersScreen } from '@/components/phone/LazyServersScreen'

export interface PhoneStackState {
  atSessions: boolean
  onBack: () => void
  /** Servers is on top (Sessions and the chat are pushed off it). */
  atServers?: boolean
  /** From Sessions down to Servers (‹ Servers, the edge swipe, Android Back). */
  onBackToServers?: () => void
  /** From Servers up to the Sessions of the server in use. */
  onOpenSessions?: () => void
}

interface ChatFrameProps {
  phoneStack?: PhoneStackState
  /** The phone's edge swipe and Back may pop to Sessions. */
  backEnabled: boolean
  header: React.ReactNode
  sidebar: React.ReactNode
  footer: React.ReactNode
  /** The chat column and the Review panel. */
  children: React.ReactNode
}

/**
 * The workbench around the chat. Desktop: the header, the sidebar beside
 * the chat, the status bar. A phone: a navigation stack, the sidebar as the
 * Sessions screen with the chat, header and all, pushed over it; and that
 * stack is itself the page of a second one, over the Servers screen. Only
 * one of the two takes the edge swipe and Back at a time: the inner one
 * while a chat is pushed, the outer one while Sessions is on top.
 */
export function ChatFrame({ phoneStack, backEnabled, header, sidebar, footer, children }: ChatFrameProps) {
  // Swiping left on Servers opens Sessions only while a server answers.
  const connected = useHealthQuery().isSuccess
  const body = <div className="relative flex min-h-0 flex-1 overflow-hidden">{children}</div>
  if (!phoneStack) {
    return (
      <>
        {header}
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          {sidebar}
          {children}
        </div>
        {footer}
      </>
    )
  }
  const sessionsStack = (
    <PhoneStack
      root={sidebar}
      page={<div className="flex h-full flex-col">{header}{body}</div>}
      pushed={!phoneStack.atSessions}
      onBack={phoneStack.onBack}
      backEnabled={backEnabled}
    />
  )
  const { onBackToServers, onOpenSessions } = phoneStack
  const atServers = Boolean(phoneStack.atServers)
  // Servers loads (and pings its servers) while it is on top or one swipe
  // away under Sessions, so a swipe back reveals the real list, not the
  // panel's placeholder rows; under a chat it rests.
  return (
    <div className="relative min-h-0 flex-1">
      {onBackToServers && onOpenSessions ? (
        <PhoneStack
          root={<ServersScreen active={phoneStack.atSessions} onOpenSessions={onOpenSessions} />}
          page={sessionsStack}
          pushed={!atServers}
          onBack={onBackToServers}
          backEnabled={backEnabled && phoneStack.atSessions && !atServers}
          onForward={backEnabled ? onOpenSessions : undefined}
          forwardBlocked={!connected}
        />
      ) : sessionsStack}
    </div>
  )
}
