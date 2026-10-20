import { useEffect, useRef, useState } from 'react'

/**
 * A title that turns into a text field in place. Enter or leaving the field
 * saves; Escape, an empty title, or an unchanged one cancels. Settles once,
 * so the blur that follows Enter or Escape does not save a second time.
 */
export function InlineTitleInput({
  initial,
  label,
  onSubmit,
  onCancel,
  className = '',
  maxLength = 255,
}: {
  initial: string
  label: string
  onSubmit: (title: string) => void
  onCancel: () => void
  className?: string
  maxLength?: number
}) {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)
  const settled = useRef(false)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const settle = (save: boolean) => {
    if (settled.current) return
    settled.current = true
    const title = value.trim()
    if (save && title && title !== initial.trim()) onSubmit(title)
    else onCancel()
  }

  return (
    <input
      ref={inputRef}
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      enterKeyHint="done"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          settle(true)
        } else if (event.key === 'Escape') {
          // Escape belongs to the field here, not to a surrounding panel.
          event.preventDefault()
          event.stopPropagation()
          settle(false)
        }
      }}
      onBlur={() => settle(true)}
      onClick={(event) => event.stopPropagation()}
      aria-label={label}
      maxLength={maxLength}
      className={`min-w-0 rounded-xs border border-(--focus-ring) bg-(--bg-page) px-1 text-(--color-text) outline-none ring-2 ring-(--focus-ring)/25 ${className}`}
    />
  )
}
