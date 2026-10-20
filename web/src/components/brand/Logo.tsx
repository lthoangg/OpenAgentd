/**
 * The OpenAgentd logo, drawn inline from the generated outlines
 * (`lib/brand/logo-data.ts`, built by `scripts/brand/brand.ts`). Never redraw
 * it by hand.
 *
 * - `Seal`: the ink disc with the open A cut out and the Signal Blue dot (the
 *   agent) as its crossbar. `pulse` slowly pulses the dot; loaders only.
 * - `Wordmark`: "OpenAgentd" with the same open A and dot.
 *
 * The ink is `currentColor` (callers set it, usually `--color-text`) and the
 * dot is `--logo-signal` (Signal Blue in `index.css` and `tray.css`). No
 * Tailwind classes inside, so the tray popup can use it too. Without `title`
 * the logo is decorative.
 */
import { LOGO } from '@/lib/brand/logo-data'

function a11y(title?: string) {
  return title
    ? ({ role: 'img', 'aria-label': title } as const)
    : ({ 'aria-hidden': true, focusable: false } as const)
}

export function Seal({
  size = 88,
  title,
  pulse = false,
  className,
}: {
  size?: number
  title?: string
  pulse?: boolean
  className?: string
}) {
  const { seal } = LOGO
  return (
    <svg
      viewBox={`0 0 ${seal.grid} ${seal.grid}`}
      width={size}
      height={size}
      className={className}
      data-logo="seal"
      {...a11y(title)}
    >
      <path fillRule="evenodd" d={seal.disc} fill="currentColor" />
      <circle
        cx={seal.dot.cx}
        cy={seal.dot.cy}
        r={seal.dot.r}
        fill="var(--logo-signal)"
        className={pulse ? 'oa-seal-pulse' : undefined}
      />
    </svg>
  )
}

export function Wordmark({ height = 20, title, className }: { height?: number; title?: string; className?: string }) {
  const [x, y, w, h] = LOGO.viewBox
  return (
    <svg
      viewBox={`${x} ${y} ${w} ${h}`}
      height={height}
      width={Math.round((height * w) / h * 10) / 10}
      className={className}
      data-logo="wordmark"
      {...a11y(title)}
    >
      {LOGO.letters.map((letter) => (
        <path key={letter.d} d={letter.d} fill="currentColor" />
      ))}
      <path d={LOGO.a} fill="currentColor" />
      <circle cx={LOGO.dot.cx} cy={LOGO.dot.cy} r={LOGO.dot.r} fill="var(--logo-signal)" />
    </svg>
  )
}
