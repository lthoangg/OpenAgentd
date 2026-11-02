/**
 * Whether a show/hide toggle is still sliding: true from the very render in
 * which ``open`` flips (so the new width and its CSS transition land in one
 * commit) until ``ms`` later. False at mount, so a panel that starts open
 * does not slide in, and false at rest, so a window resize or a drag moves
 * an edge at once.
 */
import { useEffect, useState } from 'react'

export function useToggleTween(open: boolean, ms: number): boolean {
  const [state, setState] = useState({ open, running: false })
  // Derived during render, not in an effect: an effect would add the
  // transition one commit after the width had already jumped.
  if (state.open !== open) setState({ open, running: true })
  useEffect(() => {
    if (!state.running) return
    const timer = setTimeout(() => setState((current) => (current.running ? { ...current, running: false } : current)), ms)
    return () => clearTimeout(timer)
  }, [state, ms])
  return state.running
}
