/**
 * The one keydown listener behind every app shortcut.
 *
 * It listens on ``window`` in the bubble phase, after element handlers, so a
 * focused widget that owns a key (composer menus, dropdown triggers, xterm,
 * palette sub-pages) keeps it: that handler calls ``preventDefault`` or stops
 * the event, and handled events are skipped here. For the rest, the first
 * match wins, in this order:
 *
 * 1. keys owned by the top layer (lightbox arrows),
 * 2. Escape, which closes the top layer — one press, one thing,
 * 3. keys for the focused region (composer Escape, Settings save),
 * 4. app shortcuts — unless a dialog or overlay is open. Then only
 *    switchers run (over overlays that allow it), and every other app
 *    chord is swallowed, so ⌘W never reaches the desktop window's native
 *    Close Window behind a dialog.
 *
 * An app shortcut that runs closes the menus and popovers open, as a key
 * equivalent closes a native menu, and so does focus going into a frame (a
 * click in a preview page or an MCP app, which this document never sees).
 *
 * Within a tier the latest registration wins; a handler that returns
 * ``false`` passes the key on.
 */
import { getPlatform } from '@/hooks/use-platform'
import { APP_SHORTCUT_CHORDS } from '@/lib/app-shortcuts'
import { isEditableTarget } from '@/lib/is-editable-target'

import { isImeComposing, matchChord, type KeyChord } from './chord'
import { _resetLayersForTests, closeTransientLayers, layerStack, type KeyLayer } from './layers'

export interface ShortcutOptions {
  enabled?: boolean
  /** Only while this layer is on top (a layer id or a ref holding one). */
  layer?: number | { readonly current: number | null }
  /** Only when the key press comes from inside this element. */
  within?: () => Element | null
  /** May replace an open overlay (⌘K, ⌘P, ⌘,). */
  switcher?: boolean
  /**
   * Fire while focus is in a text field. Defaults to true for chords with
   * the primary modifier and for Escape, false for bare keys.
   */
  allowInEditable?: boolean
}

/** Return ``false`` to leave the key to the next match. */
export type ShortcutHandler = (event: KeyboardEvent) => void | boolean

interface Binding {
  seq: number
  chord: KeyChord
  handler: ShortcutHandler
  options: () => ShortcutOptions
}

let bindings: Binding[] = []
let seq = 0
let installed = false

/** Attach the listener (once). Layers need it even with no shortcut registered. */
export function installKeyboard(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('keydown', dispatchKey)
  window.addEventListener('blur', closeMenusForFrame)
}

let frameTimer: ReturnType<typeof setTimeout> | undefined
/** The window lost focus: if a frame of ours took it, that was a click outside the menus. */
function closeMenusForFrame(): void {
  clearTimeout(frameTimer)
  // After the blur: by then the frame is the active element in every engine.
  frameTimer = setTimeout(() => {
    if (document.activeElement instanceof HTMLIFrameElement) closeTransientLayers()
  }, 0)
}

export function registerShortcut(
  chord: KeyChord,
  handler: ShortcutHandler,
  options: () => ShortcutOptions = () => ({}),
): () => void {
  installKeyboard()
  const binding: Binding = { seq: seq++, chord, handler, options }
  bindings = [...bindings, binding]
  return () => {
    bindings = bindings.filter((b) => b !== binding)
  }
}

function layerIdOf(options: ShortcutOptions): number | null | undefined {
  const layer = options.layer
  if (layer === undefined) return undefined
  return typeof layer === 'number' ? layer : layer.current
}

function inRegion(options: ShortcutOptions, target: EventTarget | null): Element | null {
  const region = options.within?.()
  if (!region || !(target instanceof Node) || !region.contains(target)) return null
  return region
}

function run(list: Binding[], event: KeyboardEvent): boolean {
  for (const binding of list) {
    if (binding.handler(event) === false) continue
    event.preventDefault()
    return true
  }
  return false
}

function canSwitch(stack: readonly KeyLayer[]): boolean {
  return stack.every((layer) => layer.kind !== 'dialog' && layer.allowSwitch?.() !== false)
}

// Test files mock `use-platform` with partial exports; never let that break
// every key press.
function currentOs() {
  return typeof getPlatform === 'function' ? getPlatform().os : 'unknown'
}

export function dispatchKey(event: KeyboardEvent): void {
  if (event.defaultPrevented || isImeComposing(event)) return
  const os = currentOs()
  const stack = layerStack()
  const top = stack.at(-1) ?? null
  const blocking = [...stack].reverse().find((layer) => layer.kind !== 'transient') ?? null
  const editable = isEditableTarget(event.target)

  const matches = bindings
    .filter((binding) => {
      const options = binding.options()
      if (options.enabled === false || !matchChord(event, binding.chord, os)) return false
      const allowInEditable = options.allowInEditable ?? (Boolean(binding.chord.mod) || binding.chord.key === 'Escape')
      return !editable || allowInEditable
    })
    .sort((a, b) => b.seq - a.seq)

  // 1. Keys owned by the top layer; keys of covered layers never run.
  const owned = matches.filter((binding) => {
    const id = layerIdOf(binding.options())
    return id !== undefined && id !== null && id === top?.id
  })
  if (run(owned, event)) return

  // 2. Escape closes the top layer only.
  if (top && event.key === 'Escape') {
    event.preventDefault()
    top.close()
    return
  }

  const free = matches.filter((binding) => layerIdOf(binding.options()) === undefined)
  const regions = free.filter((binding) => {
    const options = binding.options()
    const region = options.within && inRegion(options, event.target)
    if (!region) return false
    // Under a blocking layer only regions inside it (its own pages) count.
    return !blocking || Boolean(blocking.element?.()?.contains(region))
  })
  if (run(regions, event)) return

  const app = free.filter((binding) => !binding.options().within)
  if (!blocking) {
    // The menus open before the key: a toggle that just closed one is no matter.
    const open = stack.filter((layer) => layer.kind === 'transient')
    if (run(app, event)) for (const layer of open) layer.close()
    return
  }

  // 4. Behind a dialog or overlay: switchers only, everything else swallowed.
  const switchers = app.filter((binding) => binding.options().switcher)
  if (switchers.length > 0 && canSwitch(stack)) {
    for (const layer of [...stack].reverse()) {
      if (layer.closeOnSwitch ?? layer.kind === 'transient') layer.close()
    }
    if (run(switchers, event)) return
  }
  if (app.length > 0 || APP_SHORTCUT_CHORDS.some((chord) => matchChord(event, chord, os))) {
    event.preventDefault()
  }
}

export function _resetKeyboardForTests(): void {
  bindings = []
  _resetLayersForTests()
}
