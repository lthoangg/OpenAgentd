/**
 * Whether the sidebar shows session search in place of its lists. Opening
 * it (the Search button, or ⌘⇧F through ``searchSessionsKey``) focuses the
 * field; closing it gives focus back to the Search button.
 */
import { useEffect, useRef, useState } from 'react'

export function useSessionSearchOpen(searchSessionsKey: number) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchFocusKey, setSearchFocusKey] = useState(0)
  const searchButtonRef = useRef<HTMLButtonElement>(null)
  const openSessionSearch = () => {
    setSearchOpen(true)
    setSearchFocusKey((key) => key + 1)
  }
  useEffect(() => {
    if (searchSessionsKey === 0) return
    setSearchOpen(true)
    setSearchFocusKey((key) => key + 1)
  }, [searchSessionsKey])
  // The header with the Search button moves from above the results back
  // into the scroller, so focus returns to it once it has re-rendered.
  const refocusSearchButton = useRef(false)
  const closeSessionSearch = () => {
    refocusSearchButton.current = true
    setSearchOpen(false)
  }
  useEffect(() => {
    if (searchOpen || !refocusSearchButton.current) return
    refocusSearchButton.current = false
    searchButtonRef.current?.focus()
  }, [searchOpen])

  return { searchOpen, setSearchOpen, searchFocusKey, searchButtonRef, openSessionSearch, closeSessionSearch }
}
