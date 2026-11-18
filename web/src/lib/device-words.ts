/**
 * Devices in plain words: "iPad", "iPhone", "computer", never "device"
 * when the app can tell. The account's kind is self-reported and says
 * `ios` for an iPhone and an iPad alike (the API has no `ipados`), so a
 * device seen only through the account is an "iPhone or iPad"; this device
 * knows what it is.
 */

/** What this device is: "iPad" or "iPhone" in the iOS app, else "phone". */
export function thisDeviceName(): 'iPhone' | 'iPad' | 'phone' {
  if (typeof navigator === 'undefined') return 'phone'
  const ua = navigator.userAgent || ''
  const platform = navigator.platform || ''
  if (/iPad/i.test(ua) || /iPad/i.test(platform)) return 'iPad'
  // iPadOS 13+ says it is a Mac; a Mac has no touch points.
  if (/Mac/i.test(platform) && (navigator.maxTouchPoints ?? 0) > 1) return 'iPad'
  if (/iPhone|iPod/i.test(ua) || /iPhone|iPod/i.test(platform)) return 'iPhone'
  return 'phone'
}

/** Whether this is an Android device (the Android app, or a browser on one). */
export function isAndroidDevice(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '')
}

/**
 * The phone the person adds this device with, as this device names it: an
 * iPhone adds a new iPad ("your iPhone"); a new iPhone is added by "your
 * other iPhone"; a new Android phone by "your other phone" (an iPhone or
 * an Android phone may add it).
 */
export function otherPhoneName(self: ReturnType<typeof thisDeviceName> = thisDeviceName(), android = isAndroidDevice()): string {
  if (android) return 'your other phone'
  return self === 'iPhone' ? 'your other iPhone' : 'your iPhone'
}

/** The phone in "No … nearby? Sign in with Google". */
export function nearbyPhoneName(android = isAndroidDevice()): string {
  return android ? 'other phone' : 'iPhone'
}

/** Kinds that are phones or tablets (they use computers, they do not serve). */
const PHONE_KINDS = new Set(['ios', 'android'])

/** Whether a device of `kind` is a phone or tablet. Unknown kinds are not. */
export function isPhoneKind(kind: string | null | undefined): boolean {
  return Boolean(kind && PHONE_KINDS.has(kind))
}

/**
 * A device the account reports with `kind`, as one noun: "iPhone or iPad"
 * (`ios` says no more), "Android phone", "computer", and "device" only when
 * the kind is missing or unknown.
 */
export function kindNoun(kind: string | null | undefined): string {
  switch (kind) {
    case 'ios': return 'iPhone or iPad'
    case 'android': return 'Android phone'
    case 'macos':
    case 'linux':
    case 'windows': return 'computer'
    default: return 'device'
  }
}
