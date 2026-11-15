/**
 * The signed-in Account screen's one list (Settings → Account, on a
 * computer and on a phone): every device of the account by its name, this
 * one first with Sign out, the others with one status line and Remove where
 * this device may remove. What used to be a separate Account panel (status,
 * key, role, sharing, remote sessions) is in each device's **Details**,
 * where a device is renamed and, by a device that approves, made an
 * approver too.
 *
 * A name is the one the account keeps for a device: every device and the
 * account pages show it. A device with none is "This computer" / "This
 * phone" when it is this one, else its system and key. A name is never what
 * a device is trusted by: Remove asks with the system and key in full.
 *
 * Above the list, while only one device can approve new devices: a short
 * note, with a button that lets another device approve too.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { ComputerDetailsDialog, deviceFacts, type ComputerFact } from '@/components/ComputerDetails'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { deviceLabel, deviceTitles, type ComputerNames } from '@/lib/app-backend'

export interface ListedDevice {
  device_id: string
  fingerprint: string
  signer: boolean
  server: boolean
  client: boolean
  me: boolean
  kind: string | null
  /** The account's name for it; absent from an older shell or server. */
  name?: string | null
  online?: boolean | null
}

/** The devices that approve new ones (departed devices are never listed). */
export function approvers<T extends Pick<ListedDevice, 'signer'>>(devices: T[]): T[] {
  return devices.filter((device) => device.signer)
}

/** Whether this device is the only one that approves new devices. */
export function onlyApproverIsMe(devices: Array<Pick<ListedDevice, 'signer' | 'me'>> | undefined): boolean {
  if (!devices) return false
  const signers = approvers(devices)
  return signers.length === 1 && signers[0].me
}

/** The device a lone approver would most likely let approve too: one with a screen (it opens others) first. */
function nextApprover(devices: ListedDevice[]): ListedDevice | null {
  const others = devices.filter((device) => !device.me && !device.signer)
  return others.find((device) => device.client) ?? others[0] ?? null
}

/** The one line under another device. */
function otherLine(device: ListedDevice): string | undefined {
  const parts = [
    device.online === true ? 'Online' : device.online === false ? "Can't reach" : null,
    device.signer ? 'Approves new devices' : null,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/** The upload of names this app kept before the account kept them, done once per account. */
const NAMES_UPLOADED_KEY = 'openagentd.cloud.namesUploaded'

function uploadedFor(): string | null {
  try {
    return window.localStorage.getItem(NAMES_UPLOADED_KEY)
  } catch {
    return null
  }
}

function markUploaded(key: string) {
  try {
    window.localStorage.setItem(NAMES_UPLOADED_KEY, key)
  } catch {
    // Storage unavailable: tried again next time, which changes nothing.
  }
}

/**
 * Once per account, after an update: the names this app remembered for the
 * account's computers go to the account, where it has none yet. Only a
 * device that approves may name others; this device's own name is its
 * computer's to send.
 */
function useUploadRememberedNames(devices: ListedDevice[] | undefined, names: ComputerNames | null | undefined, meSigner: boolean, upload?: (deviceId: string, name: string) => Promise<unknown>) {
  const started = useRef(false)
  useEffect(() => {
    if (!devices || !upload || !names || started.current) return
    const me = devices.find((device) => device.me)
    // An older shell or server keeps no account names: nothing to upload to.
    if (!me || devices.some((device) => device.name === undefined)) return
    const key = me.device_id
    if (uploadedFor() === key) return
    started.current = true
    const todo = meSigner
      ? devices.filter((device) => !device.me && device.name === null && names[device.device_id]?.trim())
      : []
    void Promise.allSettled(todo.map((device) => upload(device.device_id, names[device.device_id].trim())))
      .then(() => markUploaded(key))
  }, [devices, names, meSigner, upload])
}

export function DeviceRows({
  devices,
  loading = false,
  names,
  selfLabel,
  selfLine,
  selfFacts = [],
  meSigner,
  canChange,
  changeElsewhere,
  onAdd,
  onRemove,
  removeEffect,
  onMakeApprover,
  rename,
  renameHint,
  uploadName,
  onSignOut,
  signOutDisabled = false,
  noApproverNote = false,
}: {
  devices: ListedDevice[] | undefined
  loading?: boolean
  /** Names this app remembered before the account kept them, by device id (older shells and servers, and the one upload). */
  names?: ComputerNames | null
  /** "This computer" or "This phone". */
  selfLabel: string
  /** What this device is doing, under its name ("Reachable from your devices"). */
  selfLine?: string
  /** More about this device for its Details (its status, its sessions). */
  selfFacts?: ComputerFact[]
  /** This device approves new devices. */
  meSigner: boolean
  /** This window may sign a change to the account (the desktop app, the phone). */
  canChange: boolean
  /** Where changes are made instead, for an approver that cannot here. */
  changeElsewhere?: string
  onAdd?: () => void
  /** Removes a device; absent where this device may not. */
  onRemove?: (deviceId: string) => Promise<unknown>
  /** What removal does, after the device's system and key. */
  removeEffect: string
  /** Lets another device approve too; absent where this device may not. */
  onMakeApprover?: (deviceId: string) => Promise<unknown>
  /** How a device is renamed from here, or null where it cannot be. */
  rename: (device: ListedDevice) => ((name: string) => Promise<void>) | null
  /** Shown in Details where Rename would be. */
  renameHint?: (device: ListedDevice) => string | undefined
  /** Sends a remembered name to the account (the one upload). */
  uploadName?: (deviceId: string, name: string) => Promise<unknown>
  onSignOut?: () => void
  signOutDisabled?: boolean
  /** No one-approver note (just after a recovery, whose own note says it). */
  noApproverNote?: boolean
}) {
  const [removing, setRemoving] = useState<string | null>(null)
  // Details stays on its device while the dialog closes.
  const [detailsId, setDetailsId] = useState<string | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [promoting, setPromoting] = useState<string | null>(null)
  const [promoteError, setPromoteError] = useState<string | null>(null)
  useUploadRememberedNames(devices, names, meSigner, uploadName)

  const list = [...(devices ?? [])].sort((a, b) => Number(b.me) - Number(a.me))
  const titles = deviceTitles(list, names)
  const named = (device: ListedDevice) => Boolean((device.name !== undefined ? device.name : names?.[device.device_id])?.trim())
  const titleOf = (device: ListedDevice) => (device.me && !named(device) ? selfLabel : titles.get(device.device_id) ?? deviceLabel(device))
  const detailed = list.find((device) => device.device_id === detailsId) ?? null
  const toRemove = list.find((device) => device.device_id === removing) ?? null
  const promote = onMakeApprover && canChange && meSigner ? onMakeApprover : undefined

  const makeApprover = async (deviceId: string) => {
    if (!promote) return
    setPromoting(deviceId)
    setPromoteError(null)
    try {
      await promote(deviceId)
    } catch (error) {
      setPromoteError(error instanceof Error ? error.message : String(error))
    } finally {
      setPromoting(null)
    }
  }

  // In a sentence: its name, else what it is (never its key).
  const spoken = (device: ListedDevice) => (named(device) ? titleOf(device) : device.kind === 'ios' || device.kind === 'android' ? 'your phone' : 'your computer')
  const signers = approvers(list)
  const next = nextApprover(list)
  let note: ReactNode = null
  if (signers.length === 1 && !noApproverNote) {
    const only = signers[0]
    const one = selfLabel.replace(/^This /, '')
    note = only.me ? (
      <Callout tone="info" role="status" title={`Only this ${one} can approve new devices.`}>
        <span className="block">
          {next
            ? <>Keep your recovery code safe, or let <bdi>{spoken(next)}</bdi> approve too.</>
            : 'Keep your recovery code safe.'}
        </span>
        {next && promote && (
          // One span: the button's flex gap would space the name apart.
          <Button className="mt-2" variant="primary" size="sm" disabled={promoting !== null} onClick={() => { void makeApprover(next.device_id) }}>
            <span>Let <bdi>{spoken(next)}</bdi> approve</span>
          </Button>
        )}
      </Callout>
    ) : (
      <Callout tone="info" role="status" title={<>Only <bdi>{spoken(only)}</bdi> can approve new devices.</>}>
        Keep your recovery code safe.
      </Callout>
    )
  }

  return (
    <>
      {note}
      {promoteError && <Callout tone="error" role="alert">{promoteError}</Callout>}
      <PanelSection
        title="Devices"
        description={meSigner && !canChange ? changeElsewhere : undefined}
        flush
        actions={onAdd && canChange && <Button size="sm" variant="primary" onClick={onAdd}>Add a device</Button>}
      >
        {loading && <PanelRow label="Loading devices…" />}
        {list.map((device) => (
          <PanelRow
            key={device.device_id}
            label={<bdi>{titleOf(device)}</bdi>}
            description={device.me ? [named(device) ? selfLabel : null, selfLine].filter(Boolean).join(' · ') || undefined : otherLine(device)}
          >
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Details of ${titleOf(device)}`}
              onClick={() => { setDetailsId(device.device_id); setDetailsOpen(true) }}
            >
              Details
            </Button>
            {device.me && onSignOut && (
              <Button size="sm" disabled={signOutDisabled} onClick={onSignOut}>Sign out</Button>
            )}
            {onRemove && canChange && !device.me && (
              <Button size="sm" variant="danger-subtle" aria-label={`Remove ${titleOf(device)}`} onClick={() => setRemoving(device.device_id)}>
                Remove
              </Button>
            )}
          </PanelRow>
        ))}
      </PanelSection>
      <ComputerDetailsDialog
        open={detailsOpen && detailed !== null}
        onOpenChange={setDetailsOpen}
        title={detailed ? titleOf(detailed) : ''}
        name={detailed ? (detailed.name !== undefined ? detailed.name : names?.[detailed.device_id]) ?? null : null}
        facts={detailed ? [...deviceFacts(detailed), ...(detailed.me ? selfFacts : [])] : []}
        rename={detailed && rename(detailed) ? {
          name: (detailed.name !== undefined ? detailed.name : names?.[detailed.device_id]) ?? '',
          save: rename(detailed) as (name: string) => Promise<void>,
        } : null}
        renameHint={detailed ? renameHint?.(detailed) : undefined}
      >
        {detailed && !detailed.me && !detailed.signer && promote ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={promoting !== null} onClick={() => { void makeApprover(detailed.device_id) }}>
              Let it approve new devices
            </Button>
          </div>
        ) : null}
      </ComputerDetailsDialog>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => { if (!open) setRemoving(null) }}
        title="Remove this device?"
        description={(
          <>
            {/* The key, in full: a name is only what the device is called. */}
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
