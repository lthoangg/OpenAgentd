/**
 * Which saved LAN server is which account computer.
 *
 * A computer signed in to the account answers `GET /api/cloud/status` with
 * its fingerprint, the same one the account lists for that device. Whenever
 * the phone sees a LAN server it asks, and remembers fingerprint → address, so
 * the Servers list can show that computer once ("via LAN") instead of twice.
 * Older servers have no such route; the answer is simply ignored.
 */
import { useSyncExternalStore } from 'react'

import { getStoredAccessKey } from '@/api/auth'
import { isPhoneCloudShell } from '@/api/phone-cloud-core'

const STORAGE_KEY = 'openagentd.cloud.lanComputers'
const CHANGED = 'openagentd:lan-computers'
const PROBE_TIMEOUT_MS = 3000

/** `3f9a 21c4` and `3F9A-21C4` are the same fingerprint. */
export const normalizeFingerprint = (fingerprint: string) => fingerprint.replace(/[\s-]+/g, '').toUpperCase()

function readRaw(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

/** Remembered fingerprint (normalized) → server origin. */
export function parseLanComputers(raw: string): Record<string, string> {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== 'object') return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    return {}
  }
}

export function rememberLanComputer(fingerprint: string, baseUrl: string): void {
  const key = normalizeFingerprint(fingerprint)
  const known = parseLanComputers(readRaw())
  if (!key || known[key] === baseUrl) return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...known, [key]: baseUrl }))
  } catch {
    return
  }
  window.dispatchEvent(new Event(CHANGED))
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGED, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(CHANGED, onChange)
    window.removeEventListener('storage', onChange)
  }
}

/** Remembered LAN computers, live. */
export function useLanComputers(): Record<string, string> {
  const raw = useSyncExternalStore(subscribe, readRaw, () => '')
  return parseLanComputers(raw)
}

/** Ask a server who it is, and remember it. Phone only; every failure is silent. */
export async function rememberLanFingerprint(baseUrl: string): Promise<void> {
  if (!isPhoneCloudShell()) return
  const origin = baseUrl.trim().replace(/\/+$/, '').replace(/\/api$/i, '')
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const key = await getStoredAccessKey(origin)
    const res = await fetch(`${origin}/api/cloud/status`, {
      cache: 'no-store',
      headers: key ? { Authorization: `Bearer ${key}` } : undefined,
      signal: controller.signal,
    })
    if (!res.ok) return
    const body: unknown = await res.json()
    const fingerprint = (body as { fingerprint?: unknown } | null)?.fingerprint
    if (typeof fingerprint === 'string' && fingerprint) rememberLanComputer(fingerprint, origin)
  } catch {
    // No route, no answer, or not JSON: nothing to remember.
  } finally {
    window.clearTimeout(timer)
  }
}
