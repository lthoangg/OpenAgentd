/**
 * The rows of an account's Devices list (Settings → Account, on a computer
 * and on a phone): each device by its name and one status line, with
 * **Details** for its system, key and role, and **Remove** for the others
 * where this device may remove.
 *
 * A name is what a computer calls itself, as this app last saw it; a phone
 * has none and is titled by its system and key. A name is never what a
 * device is trusted by: Remove asks with the system and key in full.
 */
import { useState } from 'react'

import { ComputerDetailsDialog, deviceFacts } from '@/components/ComputerDetails'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { PanelRow } from '@/components/ui/panel-row'
import { deviceLabel, deviceTitles, type ComputerNames } from '@/lib/app-backend'

export interface ListedDevice {
  device_id: string
  fingerprint: string
  signer: boolean
  server: boolean
  client: boolean
  me: boolean
  kind: string | null
  online?: boolean | null
}

/** The one line under a device: that it is this one, else what the account knows of it. */
function statusLine(device: ListedDevice, selfLabel: string): string | undefined {
  if (device.me) return selfLabel
  if (device.online === true) return 'Online'
  if (device.online === false) return 'Offline'
  return undefined
}

export function DeviceRows({ devices, names, selfLabel, onRemove, removeEffect, renameSelf = null, selfRenameHint, onRenameComputer }: {
  devices: ListedDevice[]
  /** Remembered names, by device id. */
  names: ComputerNames | null | undefined
  /** "This computer" or "This phone". */
  selfLabel: string
  /** Removes a device; absent where this device may not. */
  onRemove?: (deviceId: string) => Promise<unknown>
  /** What removal does, after the device's system and key. */
  removeEffect: string
  /** Rename this computer: only while the app is on its server. */
  renameSelf?: { name: string; save: (name: string) => Promise<void> } | null
  /** Shown in this device's Details where Rename would be. */
  selfRenameHint?: string
  /** Rename another computer of the account through its link; absent where the shell cannot. */
  onRenameComputer?: (deviceId: string, name: string) => Promise<void>
}) {
  const [removing, setRemoving] = useState<string | null>(null)
  // Details stays on its device while the dialog closes.
  const [detailsId, setDetailsId] = useState<string | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const titles = deviceTitles(devices, names)
  const titleOf = (device: ListedDevice) => titles.get(device.device_id) ?? deviceLabel(device)
  const detailed = devices.find((device) => device.device_id === detailsId) ?? null
  const toRemove = devices.find((device) => device.device_id === removing) ?? null
  return (
    <>
      {devices.map((device) => (
        <PanelRow key={device.device_id} label={<bdi>{titleOf(device)}</bdi>} description={statusLine(device, selfLabel)}>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Details of ${titleOf(device)}`}
            onClick={() => { setDetailsId(device.device_id); setDetailsOpen(true) }}
          >
            Details
          </Button>
          {onRemove && !device.me && (
            <Button size="sm" variant="danger-subtle" aria-label={`Remove ${titleOf(device)}`} onClick={() => setRemoving(device.device_id)}>
              Remove
            </Button>
          )}
        </PanelRow>
      ))}
      <ComputerDetailsDialog
        open={detailsOpen && detailed !== null}
        onOpenChange={setDetailsOpen}
        title={detailed ? titleOf(detailed) : ''}
        name={detailed ? names?.[detailed.device_id] ?? null : null}
        facts={detailed ? deviceFacts(detailed) : []}
        rename={detailed?.me ? renameSelf : detailed?.server && onRenameComputer ? {
          name: names?.[detailed.device_id] ?? '',
          save: (name) => onRenameComputer(detailed.device_id, name),
        } : null}
        renameHint={detailed?.me ? selfRenameHint : detailed?.server ? 'Open this computer to rename it.' : undefined}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => { if (!open) setRemoving(null) }}
        title="Remove this device?"
        description={(
          <>
            {/* The key, in full: a name is only what the device calls itself. */}
            {toRemove && <span className="mb-1 block font-mono text-(--color-text)">{deviceLabel(toRemove)}</span>}
            <span>{removeEffect}</span>
          </>
        )}
        confirmLabel="Remove"
        onConfirm={() => (removing && onRemove ? onRemove(removing).catch(() => undefined) : undefined)}
      />
    </>
  )
}
