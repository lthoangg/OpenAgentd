import { getPlatform, type PlatformInfo } from '@/hooks/use-platform'

/**
 * The iOS and Android apps: the Tauri shell on a phone or tablet. Not a
 * phone-sized window, and not a browser on a phone.
 */
export function isMobileApp(info: Pick<PlatformInfo, 'isTauri' | 'os'> = getPlatform()): boolean {
  return info.isTauri && (info.os === 'ios' || info.os === 'android')
}
