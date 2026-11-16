/**
 * What the chat column says while there is no chat to show: the session is
 * not on the server, it or its workspace is still opening, the server does
 * not answer, or no workspace is attached. AgentChatView picks which.
 */
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { FolderCode, WifiOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { useIsMobile } from '@/hooks/use-mobile'
import { useIsPhone } from '@/hooks/use-is-phone'
import { usePlatform } from '@/hooks/use-platform'
import { APP_SHORTCUTS, dispatchAppShortcut, shortcutLabel } from '@/lib/app-shortcuts'

/** The URL names a session the server does not have. */
export function SessionNotFound() {
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const isPhone = useIsPhone()
  const { os } = usePlatform()
  return (
    <EmptyState
      icon={FolderCode}
      title="Session not found"
      body="It may have been deleted, or the link is wrong."
      action={
        // A phone's way back is the Sessions list it came from. Desktop
        // can also look for the session it meant (desktop mockup 12.5).
        <div className="flex flex-wrap justify-center gap-2">
          <Button type="button" onClick={() => navigate({ to: isPhone ? '/sessions' : '/', replace: true })}>
            {isPhone ? 'Back to Sessions' : 'New session'}
          </Button>
          {!isMobile && (
            <Button type="button" variant="subtle" onClick={() => dispatchAppShortcut(APP_SHORTCUTS.switchWorkspace, os)}>
              Find a session <span className="text-(--color-text-muted)">{shortcutLabel(APP_SHORTCUTS.switchWorkspace, os)}</span>
            </Button>
          )}
        </div>
      }
    />
  )
}

/** A session or a workspace on its way, with nothing of it on screen yet. */
export function OpeningScreen({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-(--color-border) border-t-(--color-accent)" />
      <div>
        <h2 className="text-base font-semibold text-(--color-text)">
          {title}
        </h2>
        <p className="mt-1 text-xs text-(--color-text-muted)">
          {body}
        </p>
      </div>
    </div>
  )
}

/** Opened while the server is down, nothing loaded, so no workspace is known. */
export function ServerUnreachable() {
  const queryClient = useQueryClient()
  return (
    <EmptyState
      icon={WifiOff}
      title="Can't reach the server"
      body="This session opens once the server answers again."
      action={
        <Button type="button" onClick={() => void queryClient.invalidateQueries()}>
          Retry
        </Button>
      }
    />
  )
}

export function NoWorkspace({ onOpenFolder }: { onOpenFolder: () => void }) {
  return (
    <EmptyState
      icon={FolderCode}
      title="No workspace attached"
      body="Open a workspace, a folder on this computer, to start a session."
      action={
        <Button type="button" onClick={onOpenFolder}>
          Open workspace…
        </Button>
      }
    />
  )
}
