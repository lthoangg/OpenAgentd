/**
 * React bindings for the keyboard dispatcher and layer stack.
 *
 * Handlers and options are read through refs at key-press time, so callers
 * can pass fresh closures every render without re-registering (which would
 * also change their order).
 */
import { createContext, createElement, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'

import { APP_SHORTCUTS, chordOf, type AppShortcut, type AppShortcutName } from '@/lib/app-shortcuts'

import { chordId, type KeyChord } from './chord'
import { installKeyboard, registerShortcut, type ShortcutHandler, type ShortcutOptions } from './dispatcher'
import { pushLayer, removeLayer, type LayerKind } from './layers'

export function useShortcut(chord: KeyChord | null, handler: ShortcutHandler, options: ShortcutOptions = {}): void {
  const latest = useRef({ handler, options })
  latest.current = { handler, options }
  const id = chord ? chordId(chord) : null
  const chordRef = useRef(chord)
  chordRef.current = chord
  useEffect(() => {
    const current = chordRef.current
    if (!current) return undefined
    return registerShortcut(current, (event) => latest.current.handler(event), () => latest.current.options)
  }, [id])
}

export interface ShortcutEntry {
  chord: KeyChord
  handler: ShortcutHandler
  options?: ShortcutOptions
}

/** An entry of the app shortcut table, with its chord and switcher flag. */
export function appShortcut(name: AppShortcutName, handler: ShortcutHandler, options: ShortcutOptions = {}): ShortcutEntry {
  const shortcut: AppShortcut = APP_SHORTCUTS[name]
  return { chord: chordOf(shortcut), handler, options: { switcher: shortcut.switcher, ...options } }
}

export function useAppShortcut(name: AppShortcutName, handler: ShortcutHandler, options: ShortcutOptions = {}): void {
  const entry = appShortcut(name, handler, options)
  useShortcut(entry.chord, entry.handler, entry.options)
}

/** Several shortcuts at once, e.g. a shell's shortcut map. */
export function useShortcuts(entries: ShortcutEntry[], shared: ShortcutOptions = {}): void {
  const latest = useRef({ entries, shared })
  latest.current = { entries, shared }
  const ids = entries.map((entry) => chordId(entry.chord)).join('|')
  useEffect(() => {
    const unregister = latest.current.entries.map((entry, index) =>
      registerShortcut(
        entry.chord,
        (event) => latest.current.entries[index]?.handler(event),
        () => ({ ...latest.current.shared, ...latest.current.entries[index]?.options }),
      ),
    )
    return () => unregister.forEach((fn) => fn())
  }, [ids])
}

export interface KeyLayerOptions {
  kind: LayerKind
  onClose?: () => void
  allowSwitch?: () => boolean
  closeOnSwitch?: boolean
  element?: () => Element | null
}

/** The layers a component renders inside (their ``useKeyLayer`` refs), outermost first. */
const LayerScopeContext = createContext<readonly object[]>([])

/**
 * Marks what renders inside a layer (a popover's content, a menu, a
 * drawer), so a layer opened from there keeps it open (see ``layers.ts``).
 * ``layer`` is the ref ``useKeyLayer`` returned.
 */
export function KeyLayerScope({ layer, children }: { layer: object; children?: ReactNode }) {
  const outer = useContext(LayerScopeContext)
  const value = useMemo(() => [...outer, layer], [outer, layer])
  return createElement(LayerScopeContext.Provider, { value }, children)
}

/**
 * Push a layer while ``open``. Returns a ref holding its id, for shortcuts
 * the layer owns (``useShortcut(chord, fn, { layer: ref })``), and for
 * ``KeyLayerScope``. Opening it closes the other menus and popovers open,
 * except the ones it renders inside.
 */
export function useKeyLayer(open: boolean, options: KeyLayerOptions): { readonly current: number | null } {
  const idRef = useRef<number | null>(null)
  const latest = useRef(options)
  latest.current = options
  const within = useContext(LayerScopeContext)
  const withinRef = useRef(within)
  withinRef.current = within
  useEffect(() => {
    if (!open) return undefined
    installKeyboard()
    const init = latest.current
    const id = pushLayer({
      kind: init.kind,
      closeOnSwitch: init.closeOnSwitch,
      close: () => latest.current.onClose?.(),
      allowSwitch: () => latest.current.allowSwitch?.() ?? true,
      element: () => latest.current.element?.() ?? null,
      scope: idRef,
      within: withinRef.current,
    })
    idRef.current = id
    return () => {
      removeLayer(id)
      if (idRef.current === id) idRef.current = null
    }
  }, [open])
  return idRef
}
