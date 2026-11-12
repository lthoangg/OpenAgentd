/**
 * The last row of the phone's Servers screen: **Copy diagnostics** copies
 * what the app saw of its connections to the account's computers (the
 * shell's last 50 events: the app going away and coming back, each bridge's
 * check and reopening, each link's route and why it went down, how each
 * session ended, refused requests), with the app version and the time. It
 * says "Copied" for a moment. Nothing secret is in it (`lib/connection-diagnostics`).
 */
import { PanelSection } from '@/components/ui/panel-section'
import { ROW_PAD, TEXT } from '@/components/ui/panel-tokens'
import { useCopyFeedback } from '@/hooks/use-copy-feedback'
import { getPlatform } from '@/hooks/use-platform'
import { clientVersion } from '@/lib/app-version'
import { diagnosticsText, loadDiagnostics } from '@/lib/connection-diagnostics'
import { cn } from '@/lib/utils'

function platformName(): string {
  const { os } = getPlatform()
  if (os === 'ios') return 'iOS'
  if (os === 'android') return 'Android'
  return os
}

export function ConnectionDiagnosticsRow() {
  const { copied, copy } = useCopyFeedback()
  const onCopy = async () => {
    const [lines, version] = await Promise.all([loadDiagnostics(), clientVersion()])
    await copy(diagnosticsText(lines, { version: version ?? 'unknown', platform: platformName(), now: new Date() }))
  }
  return (
    <PanelSection title="Connection" description="For a problem report: what the app saw of its connection to your computers. No keys or addresses." flush>
      <button
        type="button"
        aria-label="Copy diagnostics"
        onClick={() => { void onCopy() }}
        className={cn(
          'flex min-h-(--phone-control) w-full items-center gap-3 text-left',
          ROW_PAD,
          // No hover fill: on touch it sticks after the tap.
          'transition-colors duration-(--motion-instant) pointer-fine:hover:bg-(--bg-key)/40 active:bg-(--bg-key)/60',
          'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--focus-ring)',
        )}
      >
        <span className={cn(TEXT.label, 'min-w-0 flex-1 truncate text-(--color-accent)')}>Copy diagnostics</span>
        <span aria-live="polite" className="shrink-0 text-meta text-(--color-text-muted)">
          {copied ? 'Copied' : null}
        </span>
      </button>
    </PanelSection>
  )
}
