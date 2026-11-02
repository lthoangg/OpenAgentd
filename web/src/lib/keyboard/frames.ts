/**
 * Keys pressed inside embedded pages (Preview, MCP apps).
 *
 * Key events stay in the frame's own document, so without help ⌘W in a page
 * reaches the desktop window's native Close Window and Escape cannot leave an
 * MCP app's fullscreen. The frame runs a small forwarder: after the page's
 * own handlers (so apps that use ⌘D, ⌘B or ⌘K themselves keep them), it
 * claims app chords the page left alone, and optionally unhandled Escape,
 * and posts them to the host. The host replays them on the iframe element,
 * so the keyboard dispatcher routes them like any key pressed in the app.
 *
 * A page can post these messages itself; the host only replays them from
 * its own frame while that frame has focus, and the dispatcher's rules
 * (layers, blocked shortcuts) still apply.
 */
import { useEffect, type RefObject } from 'react'

import type { OS } from '@/hooks/use-platform'
import { APP_SHORTCUT_CHORDS } from '@/lib/app-shortcuts'
import { isPrimaryModifierOS } from '@/lib/keyboard-shortcut'

import type { KeyChord } from './chord'

export const FRAME_KEYS_NS = 'openagentd-keys'

export interface ForwardedChord {
  key: string
  code?: string
  mod: boolean
  /** The Control key itself on every OS (⌃⌥←, ⌃Tab); never with ``mod``. */
  ctrl?: boolean
  shift: boolean
  alt: boolean
}

export interface FrameKeymap {
  /** ``mod`` means ⌘ (true) or Ctrl (false). */
  mac: boolean
  chords: ForwardedChord[]
  /** Also forward Escape the page did not handle. */
  escape: boolean
}

function forwardedChord(chord: KeyChord): ForwardedChord {
  const out: ForwardedChord = {
    key: chord.key.length === 1 ? chord.key.toLowerCase() : chord.key,
    mod: Boolean(chord.mod),
    shift: Boolean(chord.shift),
    alt: Boolean(chord.alt),
  }
  if (chord.ctrl) out.ctrl = true
  if (chord.code) out.code = chord.code
  return out
}

export function frameKeymap(os: OS, extra: readonly KeyChord[] = []): FrameKeymap {
  return {
    mac: isPrimaryModifierOS(os),
    chords: [...APP_SHORTCUT_CHORDS, ...extra].map(forwardedChord),
    escape: true,
  }
}

/**
 * The forwarder as inline script (plain ES5, no dependencies), for frames
 * whose HTML the app writes itself. ``inspector.js`` carries the same logic
 * for Preview pages and gets its keymap by message instead.
 */
export function frameKeyForwarderScript(keymap: FrameKeymap): string {
  const json = JSON.stringify(keymap).replace(/</g, '\\u003c')
  return `(function(){var m=${json};var NS=${JSON.stringify(FRAME_KEYS_NS)};`
    + 'function norm(k){return k.length===1?k.toLowerCase():k}'
    + 'function editable(t){if(!t||t.nodeType!==1)return false;var n=t.tagName;return n==="INPUT"||n==="TEXTAREA"||n==="SELECT"||!!t.isContentEditable}'
    + 'function hit(e){var p=m.mac?e.metaKey:e.ctrlKey,o=m.mac?e.ctrlKey:e.metaKey;'
    // Like the host: chords without ⌘/Ctrl are typing inside a field.
    // A ``ctrl`` chord is Control on every OS, with ⌘ up.
    + 'for(var i=0;i<m.chords.length;i++){var c=m.chords[i];if(c.ctrl){if(!e.ctrlKey||e.metaKey)continue}else if(o||p!==c.mod)continue;'
    + 'if(e.altKey!==c.alt||e.shiftKey!==c.shift)continue;if(!c.mod&&!c.ctrl&&editable(e.target))continue;'
    + 'if(c.code?e.code===c.code:norm(e.key)===c.key)return true}return false}'
    + "window.addEventListener('keydown',function(e){if(e.defaultPrevented||e.isComposing)return;"
    + "var esc=m.escape&&e.key==='Escape'&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&!e.shiftKey;"
    + 'if(!esc&&!hit(e))return;e.preventDefault();'
    + "try{window.parent.postMessage({ns:NS,v:1,type:'key',key:e.key,code:e.code,metaKey:e.metaKey,ctrlKey:e.ctrlKey,shiftKey:e.shiftKey,altKey:e.altKey},'*')}catch(_){}"
    + '})})();'
}

export function parseForwardedKey(data: unknown): KeyboardEventInit | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.ns !== FRAME_KEYS_NS || d.v !== 1 || d.type !== 'key') return null
  if (typeof d.key !== 'string' || d.key.length === 0 || d.key.length > 32) return null
  return {
    key: d.key,
    code: typeof d.code === 'string' ? d.code.slice(0, 32) : '',
    metaKey: d.metaKey === true,
    ctrlKey: d.ctrlKey === true,
    shiftKey: d.shiftKey === true,
    altKey: d.altKey === true,
  }
}

/** Replay a forwarded key on the iframe, as if pressed there in the app. */
export function redispatchFrameKey(frame: HTMLIFrameElement, init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
  frame.dispatchEvent(event)
  return event.defaultPrevented
}

/** Replay keys the frame forwards (``origin`` checks it when known). */
export function useFrameKeys(frameRef: RefObject<HTMLIFrameElement | null>, options: { origin?: string | null; enabled?: boolean } = {}): void {
  const { origin, enabled = true } = options
  useEffect(() => {
    if (!enabled) return undefined
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      if (origin && event.origin !== origin) return
      const init = parseForwardedKey(event.data)
      // Only while the user is actually in that page.
      if (!init || document.activeElement !== frame) return
      redispatchFrameKey(frame, init)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [frameRef, origin, enabled])
}
