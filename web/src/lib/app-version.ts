/**
 * Client and server versions, and how far apart they are.
 *
 * The web UI ships inside the desktop and mobile shells, so a phone on
 * v3.49 can talk to a server on v3.47. The About page shows both and warns
 * when they differ by more than a patch release.
 */
import { getPlatform } from '@/hooks/use-platform'

/** The web build's version, from package.json (vite `define` in vite.config.ts). */
declare const __APP_VERSION__: string | undefined

/** Version of this web build (vite `define`); undefined under `bun test`. */
export const WEB_BUILD_VERSION: string | undefined =
  typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : undefined

/** Version of the app the user installed: the Tauri shell, else the web build. */
export async function clientVersion(): Promise<string | undefined> {
  if (getPlatform().isTauri) {
    try {
      const { getVersion } = await import('@tauri-apps/api/app')
      return await getVersion()
    } catch {
      // Fall through to the build version.
    }
  }
  return WEB_BUILD_VERSION
}

/** Human name for the client, e.g. "Android app" or "Web UI". */
export function clientLabel(): string {
  const { isTauri, os } = getPlatform()
  if (!isTauri) return 'Web UI'
  if (os === 'ios') return 'iOS app'
  if (os === 'android') return 'Android app'
  return 'Desktop app'
}

function parts(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

export type VersionSkew =
  | { kind: 'unknown' }
  | { kind: 'same' }
  /** Only the patch number differs: compatible, worth a quiet note. */
  | { kind: 'patch'; newer: 'client' | 'server' }
  /** Major or minor differs: features may be missing on one side. */
  | { kind: 'major-minor'; newer: 'client' | 'server' }

export function versionSkew(client?: string, server?: string): VersionSkew {
  const a = client ? parts(client) : null
  const b = server ? parts(server) : null
  if (!a || !b) return { kind: 'unknown' }
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      const newer = a[i] > b[i] ? 'client' : 'server'
      return i < 2 ? { kind: 'major-minor', newer } : { kind: 'patch', newer }
    }
  }
  return { kind: 'same' }
}
