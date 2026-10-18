/**
 * NetworkAccessCard — desktop-only switch that lets phones and other
 * computers on the LAN connect to the builtin backend with an access key,
 * without installing the CLI. Mounted by AppBackendDialog in the desktop shell.
 */
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SectionCard, SectionCardHeader } from '@/components/ui/section-card'
import { getPlatform, type OS } from '@/hooks/use-platform'
import {
  DEFAULT_NETWORK_ACCESS_PORT,
  getNetworkAccessKey,
  getNetworkAccessStatus,
  setNetworkAccess,
  setNetworkAccessKey,
  type NetworkAccessStatus,
} from '@/lib/app-network-access'

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

export function NetworkAccessCard() {
  const [status, setStatus] = useState<NetworkAccessStatus | null>(null)
  const [port, setPort] = useState(String(DEFAULT_NETWORK_ACCESS_PORT))
  const [key, setKey] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [customKey, setCustomKey] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  function replaceKey(next: string | null) {
    setKey(null)
    setRevealed(false)
    void run(() => setNetworkAccessKey(next)).then(() => setCustomKey(''))
  }

  const enabled = status?.enabled ?? false
  const listening = status?.listening ?? false
  const sidecarRunning = status?.sidecar_running ?? false
  const switchOn = enabled || listening
  const hint = listening && status?.port ? firewallHint(getPlatform().os, status.port) : null

  return (
    <SectionCard>
      <SectionCardHeader>Network access</SectionCardHeader>
      <div className="space-y-3.5 p-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p id="network-access-label" className="text-xs font-semibold text-(--color-text)">
              Allow devices on your network to connect
            </p>
            <p className="mt-0.5 text-xs md:text-[11px] leading-relaxed text-(--color-text-subtle)">
              {sidecarRunning
                ? 'Phones and other computers connect to the builtin backend with the access key below.'
                : 'Start the builtin backend first.'}
            </p>
          </div>
          <Switch
            aria-labelledby="network-access-label"
            checked={switchOn}
            onCheckedChange={toggle}
            disabled={pending || !status || !sidecarRunning}
          />
        </div>

        <div className="grid gap-1.5">
          <label className="text-xs md:text-[11px] font-semibold text-(--color-text-muted)" htmlFor="network-access-port">
            Preferred port
          </label>
          <Input
            id="network-access-port"
            value={port}
            onChange={(event) => setPort(event.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            className="w-28 font-mono"
            disabled={pending || switchOn}
          />
        </div>

        {status?.fallback && status.port ? (
          <p className="text-xs md:text-[11px] text-(--color-text-muted)" role="status">
            Port {status.requested_port} was in use; listening on {status.port}.
          </p>
        ) : null}

        {listening ? (
          <>
            <div className="grid gap-1.5">
              <span className="text-xs md:text-[11px] font-semibold text-(--color-text-muted)">Address</span>
              {status?.lan_urls.length ? (
                status.lan_urls.map((url) => (
                  <div key={url} className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-xs border border-(--color-border) bg-(--bg-card) px-2 py-1 font-mono text-xs md:text-[11px] text-(--color-text)">
                      {url}
                    </code>
                    <Button type="button" variant="subtle" size="xs" onClick={() => void copy(url)}>
                      copy
                    </Button>
                  </div>
                ))
              ) : (
                <p className="text-xs md:text-[11px] text-(--color-text-subtle)">
                  Listening on port {status?.port}. No LAN address was found; use this computer&apos;s IP address.
                </p>
              )}
            </div>

            <div className="grid gap-1.5">
              <span className="text-xs md:text-[11px] font-semibold text-(--color-text-muted)">Access key</span>
              <div className="flex flex-wrap items-center gap-2">
                <code
                  data-testid="network-access-key"
                  className="min-w-0 flex-1 truncate rounded-xs border border-(--color-border) bg-(--bg-card) px-2 py-1 font-mono text-xs md:text-[11px] text-(--color-text)"
                >
                  {revealed && key ? key : '••••••••••••••••'}
                </code>
                <Button type="button" variant="subtle" size="xs" onClick={() => void toggleReveal()} disabled={pending}>
                  {revealed ? 'hide' : 'show'}
                </Button>
                <Button type="button" variant="subtle" size="xs" onClick={() => void copyKey()} disabled={pending}>
                  copy
                </Button>
                <Button type="button" variant="danger-subtle" size="xs" onClick={() => replaceKey(null)} disabled={pending}>
                  regenerate
                </Button>
              </div>
              <div className="flex gap-2">
                <Input
                  aria-label="Custom access key"
                  value={customKey}
                  onChange={(event) => setCustomKey(event.target.value)}
                  placeholder="Or use your own key (16+ characters)"
                  type="password"
                  className="min-w-0 flex-1"
                  disabled={pending}
                />
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={() => replaceKey(customKey)}
                  disabled={pending || customKey.trim().length === 0}
                >
                  Use key
                </Button>
              </div>
            </div>
          </>
        ) : null}

        {hint ? <p className="text-xs md:text-[11px] leading-relaxed text-(--color-text-muted)">{hint}</p> : null}

        {error ? (
          <div className="rounded-sm border border-(--color-error)/25 bg-(--color-error-subtle) px-3.5 py-2.5 text-xs text-(--color-error)" role="alert">
            {error}
          </div>
        ) : null}

        <p className="text-xs md:text-[11px] leading-relaxed text-(--color-text-subtle)">
          Anyone with the key gets full control of this computer&apos;s agents. Traffic is plain HTTP, so use it only on
          networks you trust. Network access works while this app is open; changing the key disconnects devices that
          use the old one.
        </p>
      </div>
    </SectionCard>
  )
}
