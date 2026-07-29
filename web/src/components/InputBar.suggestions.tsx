import { useRef, useState, useEffect, useCallback, type CSSProperties, type MutableRefObject } from 'react'
import { File, Folder } from 'lucide-react'
import type { SlashCommand } from './InputBar'
import type { SuggestionMenu, SuggestionRow } from './InputBar.suggestionEngine'
import { useIsMobile } from '@/hooks/use-mobile'

/**
 * Render half of the InputBar suggestion system. The engine
 * (`InputBar.suggestionEngine.ts`) decides *which* menu is open and what it
 * contains; this component owns positioning (fixed on mobile so the menu
 * escapes `overflow: hidden` ancestors, absolute on desktop) and paints the
 * single open listbox.
 */
export function InputBarSuggestions({
  minimized,
  menu,
  activeIndex,
  optionRefs,
  onSelect,
  suggestionsBelow,
}: {
  minimized: boolean
  menu: SuggestionMenu | null
  activeIndex: number
  optionRefs: MutableRefObject<(HTMLButtonElement | null)[]>
  onSelect: (row: SuggestionRow) => void
  suggestionsBelow: boolean
}) {
  const isMobile = useIsMobile()
  const containerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const lastDesktopDirectionRef = useRef<boolean | null>(null)
  const menuOpen = menu !== null
  const [position, setPosition] = useState<{
    top: number | undefined
    bottom: number | undefined
    left: number
    right: number
    maxHeight: number
    width: number | undefined
    showBelow: boolean
  }>({
    top: undefined,
    bottom: undefined,
    left: 0,
    right: 0,
    maxHeight: 256,
    width: undefined,
    showBelow: false,
  })

  const updatePosition = useCallback(() => {
    const parentEl = containerRef.current?.parentElement
    if (!parentEl) return

    const rect = parentEl.getBoundingClientRect()

    if (isMobile) {
      const spaceAbove = rect.top
      // Use visualViewport height when available so the computation reflects the
      // actual visible region on mobile (where the soft keyboard shrinks the
      // visible area without changing window.innerHeight).
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth
      const spaceBelow = viewportHeight - rect.bottom

      // Threshold (in pixels) below which we prefer to render the menu downwards
      // if there is more space below than above.
      const threshold = 280
      const showBelow = spaceAbove < threshold && spaceBelow > spaceAbove
      const availableSpace = showBelow ? spaceBelow : spaceAbove
      // 12px padding from the screen edge
      const maxHeight = Math.max(80, Math.min(256, availableSpace - 12))

      const menuHeight = Math.min(menuRef.current?.scrollHeight ?? maxHeight, maxHeight)
      const canFlip = !showBelow && spaceBelow > spaceAbove && spaceBelow >= menuHeight + 12
      const resolvedShowBelow = showBelow || canFlip
      const resolvedAvailableSpace = resolvedShowBelow ? spaceBelow : spaceAbove
      const resolvedMaxHeight = Math.max(80, Math.min(256, resolvedAvailableSpace - 12))

      // Use fixed positioning so the menu escapes any overflow:hidden ancestor
      // (e.g. the <main> column which clips overflow on mobile). Coordinates are
      // in the visual-viewport frame (i.e. what fixed-position elements use).
      const GAP = 4 // px gap between menu edge and input bar
      setPosition({
        top: resolvedShowBelow ? rect.bottom + GAP : undefined,
        bottom: resolvedShowBelow ? undefined : viewportHeight - rect.top + GAP,
        left: rect.left,
        right: viewportWidth - rect.right,
        maxHeight: resolvedMaxHeight,
        width: undefined,
        showBelow: resolvedShowBelow,
      })
      lastDesktopDirectionRef.current = null
      return
    }

    const spaceAbove = rect.top
    const spaceBelow = window.innerHeight - rect.bottom
    const desiredHeight = Math.min(menuRef.current?.scrollHeight ?? 256, 256)
    const fitsBelow = spaceBelow >= desiredHeight + 12
    const fitsAbove = spaceAbove >= desiredHeight + 12
    const previous = lastDesktopDirectionRef.current
    let showBelow = fitsBelow
      ? (!fitsAbove || suggestionsBelow || spaceBelow >= spaceAbove)
      : !fitsAbove

    if (previous !== null && fitsAbove && fitsBelow) {
      const HYSTERESIS = 24
      if (previous) {
        showBelow = !(spaceAbove > spaceBelow + HYSTERESIS)
      } else {
        showBelow = spaceBelow >= spaceAbove - HYSTERESIS
      }
    }

    const availableSpace = showBelow ? spaceBelow : spaceAbove
    const maxHeight = Math.max(80, Math.min(256, availableSpace - 12))
    const GAP = 4

    setPosition({
      top: showBelow ? rect.height + GAP : undefined,
      bottom: showBelow ? undefined : rect.height + GAP,
      left: 0,
      right: 0,
      maxHeight,
      width: rect.width,
      showBelow,
    })
    lastDesktopDirectionRef.current = showBelow
  }, [isMobile, suggestionsBelow])

  useEffect(() => {
    if (!menuOpen) return

    updatePosition()

    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, { capture: true })
    // On mobile the soft keyboard fires visualViewport 'resize' without
    // triggering window 'resize', so subscribe separately when available.
    if (isMobile && typeof window.visualViewport?.addEventListener === 'function') {
      window.visualViewport.addEventListener('resize', updatePosition)
    }

    let resizeObserver: ResizeObserver | null = null
    const parentEl = containerRef.current?.parentElement
    if (parentEl && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        updatePosition()
      })
      resizeObserver.observe(parentEl)
      if (menuRef.current) resizeObserver.observe(menuRef.current)
    }

    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, { capture: true })
      if (isMobile && typeof window.visualViewport?.removeEventListener === 'function') {
        window.visualViewport.removeEventListener('resize', updatePosition)
      }
      resizeObserver?.disconnect()
    }
  }, [menuOpen, updatePosition, isMobile])

  if (minimized || !menu) return null

  const slashDisplayParts = (cmd: SlashCommand) => {
    const displayName = cmd.displayName ?? cmd.id
    const colon = displayName.indexOf(':')
    return {
      prefix: colon === -1 ? '' : displayName.slice(0, colon + 1),
      suffix: colon === -1 ? displayName : displayName.slice(colon + 1),
    }
  }

  const menuStyle: CSSProperties = isMobile
    ? {
        position: 'fixed',
        top: position.top,
        bottom: position.bottom,
        left: position.left,
        right: position.right,
        maxHeight: position.maxHeight,
        zIndex: 50,
      }
    : {
        position: 'absolute',
        top: position.top,
        bottom: position.bottom,
        left: position.left,
        right: position.right,
        maxHeight: position.maxHeight,
        width: position.width,
        zIndex: 50,
      }

  const menuAriaLabel =
    menu.kind === 'slash' ? 'Slash commands' : menu.kind === 'snippet' ? 'Snippets' : 'Reference workspace file'

  const optionClass = (active: boolean) =>
    `flex w-full items-center rounded-xs px-2 py-1.5 text-left text-xs transition-colors ${
      active ? 'bg-(--bg-key) text-(--color-text)' : 'text-(--color-text-muted) hover:bg-(--bg-key)/60 hover:text-(--color-text-2)'
    }`

  const categoryBadge = (category?: string) =>
    category ? (
      <span className="shrink-0 rounded-xs border border-(--color-border) bg-(--bg-key) px-1.5 py-0.5 font-mono text-[10px] text-(--color-text-muted)">
        {category}
      </span>
    ) : null

  return (
    <div ref={containerRef} className="contents">
      <div
        ref={menuRef}
        id={menu.id}
        role="listbox"
        aria-label={menuAriaLabel}
        className="overflow-y-auto overscroll-contain rounded-sm border border-(--color-border) bg-(--bg-card) p-1 shadow-md"
        style={menuStyle}
      >
        {menu.kind === 'slash' && menu.rows.map((cmd) => {
          if (cmd.isSeparator) {
            return (
              <div key={cmd.id} className="px-2 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-(--color-text-muted)">{cmd.label}</div>
            )
          }
          const idx = menu.selectable.findIndex((item) => item.id === cmd.id)
          const active = idx === activeIndex
          const { prefix, suffix } = slashDisplayParts(cmd)
          return (
            <button
              key={cmd.id}
              id={`${menu.id}-option-${idx}`}
              ref={(el) => { if (idx >= 0) optionRefs.current[idx] = el }}
              type="button"
              role="option"
              aria-selected={active}
              onMouseDown={(e) => { e.preventDefault(); onSelect(cmd) }}
              className={`${optionClass(active)} gap-3`}
            >
              <span className="shrink-0 font-mono text-xs text-(--color-accent)">
                /
                {prefix && <span className="text-(--color-text-muted)">{prefix}</span>}
                <span>{suffix}</span>
              </span>
              <span className="min-w-0 flex-1 truncate text-(--color-text-2)">
                {cmd.description}
              </span>
              {categoryBadge(cmd.category)}
            </button>
          )
        })}
        {menu.kind === 'mention' && menu.rows.map((ref, index) => {
          const active = index === activeIndex
          const isDir = ref.type === 'directory'
          const slash = ref.path.lastIndexOf('/')
          const parent = slash === -1 ? '' : ref.path.slice(0, slash + 1)
          const basename = slash === -1 ? ref.path : ref.path.slice(slash + 1)
          return (
            <button
              key={`${ref.type}:${ref.path}`}
              id={`${menu.id}-option-${index}`}
              ref={(el) => { optionRefs.current[index] = el }}
              type="button"
              role="option"
              aria-selected={active}
              onMouseDown={(e) => { e.preventDefault(); onSelect(ref) }}
              className={`${optionClass(active)} gap-2.5`}
            >
              {isDir ? (
                <Folder className="size-4 shrink-0 text-(--color-accent)" aria-hidden />
              ) : (
                <File className="size-4 shrink-0 text-(--color-text-subtle)" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {parent && <span className="text-(--color-text-subtle)">{parent}</span>}
                <span className="text-(--color-text)">{basename}</span>
                {isDir && <span className="text-(--color-text-subtle)">/</span>}
              </span>
            </button>
          )
        })}
        {menu.kind === 'snippet' && menu.rows.map((cmd, index) => {
          const active = index === activeIndex
          return (
            <button
              key={cmd.id}
              id={`${menu.id}-option-${index}`}
              ref={(el) => { optionRefs.current[index] = el }}
              type="button"
              role="option"
              aria-selected={active}
              onMouseDown={(e) => { e.preventDefault(); onSelect(cmd) }}
              className={`${optionClass(active)} gap-3`}
            >
              <span className="shrink-0 font-mono text-xs text-(--color-accent)">#{cmd.label}</span>
              <span className="min-w-0 flex-1 truncate text-(--color-text-2)">{cmd.description}</span>
              {categoryBadge(cmd.category)}
            </button>
          )
        })}
      </div>
    </div>
  )
}
