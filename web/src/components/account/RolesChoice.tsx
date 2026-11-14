/**
 * What a device shares with the account, chosen when it signs in (spec 3.1):
 * whether the account's other devices can open it (the `server` role), and
 * whether it can open the account's other computers (the `client` role). A
 * computer offers both, on by default; a phone runs no agents for other
 * devices, so that box shows disabled. The labels are the sentences
 * themselves: the role names stay in the code.
 */
import type { Roles } from '@/api/cloud'
import { Checkbox } from '@/components/ui/checkbox'

export const COMPUTER_ROLES: Roles = { server: true, client: true }
export const PHONE_ROLES: Roles = { server: false, client: true }

/** How a device's roles read in lists and details. */
export function rolesLabel(roles: Roles): string {
  if (roles.server && roles.client) return 'Can be opened, and opens other computers'
  return roles.server ? 'Can be opened by your devices' : 'Opens your other computers'
}

/** What a device waiting for approval asks for. */
export function rolesAsked(roles: Roles): string {
  if (roles.server && roles.client) return 'Asks to be opened by your devices, and to open your computers'
  return roles.server ? 'Asks to be opened by your devices' : 'Asks to open your computers'
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
  /** A phone: being opened by other devices is shown but cannot be ticked. */
  phone?: boolean
  /** Approving: only the roles the device asked for can stay on. */
  allowed?: Roles
}) {
  const serverOff = phone || disabled || (allowed !== undefined && !allowed.server)
  const clientOff = disabled || (allowed !== undefined && !allowed.client)
  // Approving is about the device that asked; otherwise it is this one.
  const it = allowed !== undefined ? 'it' : phone ? 'this phone' : 'this computer'
  const It = allowed !== undefined ? 'It' : phone ? 'This phone' : 'This computer'
  return (
    <fieldset className="space-y-2">
      <legend className="sr-only">What this device shares</legend>
      <label className="flex items-start gap-2">
        <Checkbox
          checked={value.server}
          disabled={serverOff}
          onCheckedChange={(server) => onChange?.({ ...value, server })}
        />
        <span>
          <span className="text-(--color-text)">My other devices can open {it}</span>
          <span className="block text-(--color-text-subtle)">
            {phone ? 'A phone does not run agents for other devices.' : 'From anywhere.'}
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
          <span className="text-(--color-text)">{It} can open my other computers</span>
        </span>
      </label>
      {!value.server && !value.client && (
        <p role="alert" className="text-xs text-(--color-error)">Choose at least one.</p>
      )}
    </fieldset>
  )
}
