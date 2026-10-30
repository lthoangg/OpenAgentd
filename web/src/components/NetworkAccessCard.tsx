/**
 * NetworkAccessCard — desktop-only switch that lets phones and other
 * computers on the LAN connect to the builtin backend with an access key,
 * without installing the CLI. Mounted by AppBackendPanel in the desktop shell
 * (Settings → Connection and the Backend connection dialog).
 */
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConnectQrCode } from '@/components/ConnectQrCode'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Callout } from '@/components/ui/callout'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { TEXT } from '@/components/settings/tokens'
import { getPlatform, type OS } from '@/hooks/use-platform'
import { cn } from '@/lib/utils'
import {
  DEFAULT_NETWORK_ACCESS_PORT,
  getNetworkAccessKey,
  getNetworkAccessStatus,
  setNetworkAccess,
  setNetworkAccessKey,
  type NetworkAccessStatus,
} from '@/lib/app-network-access'
import { buildConnectLink } from '@/lib/connect-link'

function message(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : 'Network access failed.'
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Clipboard denied: the value stays visible for manual copying.
  }
}

/**
 * What to check when devices cannot connect. The app cannot see a firewall
 * block from this machine (connections to itself skip the firewall).
 */
export function firewallHint(os: OS, port: number): string | null {
  if (os === 'windows') {
    return 'If devices can\u2019t connect, make sure this Wi-Fi is set to a Private network in Windows settings; the OpenAgentd firewall rule only covers Private networks.'
  }
  if (os === 'linux') {
    return `If devices can\u2019t connect, open the port in your firewall, for example \`sudo ufw allow ${port}/tcp\` or \`sudo firewall-cmd --add-port=${port}/tcp\`.`
  }
  if (os === 'macos') {
    return 'If devices can\u2019t connect and the macOS firewall is on, allow incoming connections for openagentd in System Settings \u203a Network \u203a Firewall.'
  }
  return null
}

export function NetworkAccessCard({ title = 'Network access' }: {
  /** Heading of the first section; the Network access page passes its own. */
  title?: string
} = {}) {
  const [status, setStatus] = useState<NetworkAccessStatus | null>(null)
  const [port, setPort] = useState(String(DEFAULT_NETWORK_ACCESS_PORT))
  const [key, setKey] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [qrLink, setQrLink] = useState<string | null>(null)
  const [customKey, setCustomKey] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmKey, setConfirmKey] = useState<{ next: string | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    getNetworkAccessStatus()
      .then((next) => {
        if (cancelled) return
        setStatus(next)
        setPort(String(next.requested_port))
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(message(err))
      })
    return () => { cancelled = true }
  }, [])

  async function run(action: () => Promise<NetworkAccessStatus>) {
    setPending(true)
    setError(null)
    try {
      const next = await action()
      setStatus(next)
      setPort(String(next.requested_port))
      if (next.error) setError(next.error)
    } catch (err) {
      setError(message(err))
    } finally {
      setPending(false)
    }
  }

  function toggle(enabled: boolean) {
    const parsed = Number(port)
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
      setError('Choose a port between 1024 and 65535.')
      return
    }
    setKey(null)
    setRevealed(false)
    setQrLink(null)
    void run(() => setNetworkAccess(enabled, parsed))
  }

  async function loadKey(): Promise<string | null> {
    if (key) return key
    try {
      const stored = await getNetworkAccessKey()
      setKey(stored)
      return stored
    } catch (err) {
      setError(message(err))
      return null
    }
  }

  async function toggleReveal() {
    if (revealed) {
      setRevealed(false)
      return
    }
    if (await loadKey()) setRevealed(true)
  }

  async function copyKey() {
    const value = await loadKey()
    if (value) await copy(value)
  }

  async function toggleQr() {
    if (qrLink) {
      setQrLink(null)
      return
    }
    const urls = status?.lan_urls ?? []
    if (!urls.length) return
    const value = await loadKey()
    if (value) setQrLink(buildConnectLink({ urls, key: value }))
  }

  function replaceKey(next: string | null) {
    setKey(null)
    setRevealed(false)
    setQrLink(null)
    void run(() => setNetworkAccessKey(next)).then(() => setCustomKey(''))
  }

  const enabled = status?.enabled ?? false
  const listening = status?.listening ?? false
  const sidecarRunning = status?.sidecar_running ?? false
  const switchOn = enabled || listening
  const hint = listening && status?.port ? firewallHint(getPlatform().os, status.port) : null

  return (
    <div className="space-y-8">
      <PanelSection
        title={title}
        description="Let phones and other computers on your local network use the built-in server."
        flush
      >
        <PanelRow
          label="Allow devices on your network to connect"
          labelId="network-access-label"
          description={sidecarRunning
            ? 'Phones and other computers connect to the built-in server with the access key below.'
            : 'Start the built-in server first.'}
        >
          <Switch
            aria-labelledby="network-access-label"
            checked={switchOn}
            onCheckedChange={toggle}
            disabled={pending || !status || !sidecarRunning}
          />
        </PanelRow>

        <PanelRow
          label="Port"
          htmlFor="network-access-port"
          description={
            status?.fallback && status.port ? (
              <span role="status">Port {status.requested_port} was in use; listening on {status.port}.</span>
            ) : (
              'Used when network access turns on. Turn it off to change the port.'
            )
          }
        >
          <Input
            id="network-access-port"
            value={port}
            onChange={(event) => setPort(event.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            className="h-9 w-28 font-mono"
            disabled={pending || switchOn}
          />
        </PanelRow>

        {error ? (
          <div className="px-4 py-3">
            <Callout tone="error" role="alert">{error}</Callout>
          </div>
        ) : null}
      </PanelSection>

      {listening ? (
        <PanelSection title="Connect a device" flush>
            <PanelRow
              label="Address"
              description="Open it on the other device, or scan the QR code."
              stack
            >
              <div className="space-y-2">
                {status?.lan_urls.length ? (
                  status.lan_urls.map((url) => (
                    <div key={url} className="flex items-center gap-2">
                      <code className={CODE_BOX}>{url}</code>
                      <Button type="button" variant="subtle" size="sm" onClick={() => void copy(url)} aria-label={`Copy ${url}`}>
                        Copy
                      </Button>
                    </div>
                  ))
                ) : (
                  <p className={TEXT.hint}>
                    Listening on port {status?.port}. No local network address was found; use this computer&apos;s IP address.
                  </p>
                )}
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={() => void toggleQr()}
                  disabled={pending || !status?.lan_urls.length}
                >
                  {qrLink ? 'Hide QR' : 'Show QR'}
                </Button>
                {qrLink ? (
                  <div className="flex flex-col items-center gap-3 rounded-sm border border-(--color-border) bg-(--bg-page) p-5">
                    <ConnectQrCode value={qrLink} />
                    <p className={cn('max-w-xs text-center', TEXT.hint)}>
                      Scan with your phone&apos;s camera to open OpenAgentd and connect. The code contains the access key.
                    </p>
                  </div>
                ) : null}
              </div>
            </PanelRow>

            <PanelRow
              label="Access key"
              description="Every device needs it. Changing it disconnects devices that use the old one."
              stack
            >
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <code data-testid="network-access-key" className={CODE_BOX}>
                    {revealed && key ? key : '••••••••••••••••'}
                  </code>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button type="button" variant="subtle" size="sm" onClick={() => void toggleReveal()} disabled={pending}>
                      {revealed ? 'Hide' : 'Show'}
                    </Button>
                    <Button type="button" variant="subtle" size="sm" onClick={() => void copyKey()} disabled={pending} aria-label="Copy key">
                      Copy
                    </Button>
                    <Button type="button" variant="danger-subtle" size="sm" onClick={() => setConfirmKey({ next: null })} disabled={pending}>
                      Regenerate…
                    </Button>
                  </div>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    aria-label="Custom access key"
                    value={customKey}
                    onChange={(event) => setCustomKey(event.target.value)}
                    placeholder="Or use your own key (16+ characters)"
                    type="password"
                    className="h-9 min-w-0 flex-1"
                    disabled={pending}
                  />
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    className="h-9"
                    onClick={() => setConfirmKey({ next: customKey })}
                    disabled={pending || customKey.trim().length === 0}
                  >
                    Use key…
                  </Button>
                </div>
              </div>
            </PanelRow>
        </PanelSection>
      ) : null}

      <ConfirmDialog
        open={confirmKey !== null}
        onOpenChange={(open) => { if (!open) setConfirmKey(null) }}
        title={confirmKey?.next === null ? 'Regenerate the access key?' : 'Replace the access key?'}
        description="Every device that uses the old key disconnects and needs the new key to connect again."
        confirmLabel={confirmKey?.next === null ? 'Regenerate key' : 'Use new key'}
        onConfirm={() => { if (confirmKey) replaceKey(confirmKey.next) }}
      />

      <Callout tone="warning" title="Before you share access">
        <div className="space-y-2">
          {hint ? <p>{hint}</p> : null}
          <p>
            Anyone with the key controls this computer&apos;s agents, and traffic is plain HTTP: use it only on
            networks you trust. Access ends when the app quits.
          </p>
        </div>
      </Callout>
    </div>
  )
}

const CODE_BOX = 'min-w-0 flex-1 truncate rounded-sm border border-(--color-border) bg-(--bg-page) px-2.5 py-2 font-mono text-xs text-(--color-text) select-text'
