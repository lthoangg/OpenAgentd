import { usePhoneCloudStatus } from '@/queries/phone-cloud-status'

/**
 * Keeps the phone's account in step while the app runs. Reading the status is
 * enough: once the account is connected (and on every launch while it is),
 * `usePhoneCloudStatus` quietly registers this phone for push. Renders nothing.
 */
export function PhoneCloudSync(): null {
  usePhoneCloudStatus()
  return null
}
