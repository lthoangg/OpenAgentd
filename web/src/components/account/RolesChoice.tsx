/**
 * What a device is used as, chosen when it signs in (spec 3.1): **Use as
 * server** (other devices open sessions on it) and **Use as client** (it
 * opens sessions on the account's other computers). A computer offers both,
 * on by default; a phone has no server to offer, so that box shows disabled.
 */
import type { Roles } from '@/api/cloud'
import { Checkbox } from '@/components/ui/checkbox'

export const COMPUTER_ROLES: Roles = { server: true, client: true }
export const PHONE_ROLES: Roles = { server: false, client: true }

/** "Server and client", "Server", "Client": how a device's roles read in lists. */
export function rolesLabel(roles: Roles): string {
  if (roles.server && roles.client) return 'Server and client'
  return roles.server ? 'Server' : 'Client'
}

export function RolesChoice({
  value,
  onChange,
  disabled = false,
  phone = false,
  allowed,
}: {
  value: Roles
  onChange?: (roles: Roles) => void
  disabled?: boolean
  /** A phone: Use as server is shown but cannot be ticked. */
  phone?: boolean
  /** Approving: only the roles the device asked for can stay on. */
  allowed?: Roles
}) {
  const serverOff = phone || disabled || (allowed !== undefined && !allowed.server)
  const clientOff = disabled || (allowed !== undefined && !allowed.client)
  return (
    <fieldset className="space-y-2">
      <legend className="sr-only">Use this device as</legend>
      <label className="flex items-start gap-2">
        <Checkbox
          checked={value.server}
          disabled={serverOff}
          onCheckedChange={(server) => onChange?.({ ...value, server })}
        />
        <span>
          <span className="text-(--color-text)">Use as server</span>
          <span className="block text-(--color-text-subtle)">
            {phone ? 'A phone does not run agents for other devices.' : 'Your other devices can use this one, from anywhere.'}
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2">
        <Checkbox
          checked={value.client}
          disabled={clientOff}
          onCheckedChange={(client) => onChange?.({ ...value, client })}
        />
        <span>
          <span className="text-(--color-text)">Use as client</span>
          <span className="block text-(--color-text-subtle)">This one can use your other computers.</span>
        </span>
      </label>
      {!value.server && !value.client && (
        <p role="alert" className="text-xs text-(--color-error)">Choose at least one.</p>
      )}
    </fieldset>
  )
}
