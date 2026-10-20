/**
 * Callout — the one notice style on panels and overlays: a tinted box with
 * an optional bold first line, for states and warnings that sit between
 * sections (a server that failed to start, a scanned connect link, a
 * security caveat). Not for field errors; rows and fields show those inline.
 */
import { type ReactNode } from 'react'
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react'

import { ICON_SIZE } from '@/components/ui/panel-tokens'
import { cn } from '@/lib/utils'

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'error'

const TONE: Record<Tone, string> = {
  neutral: 'border-(--color-border) bg-(--bg-card) text-(--color-text-muted)',
  info: 'border-(--color-info)/30 bg-(--color-info-subtle) text-(--accent-blue-text)',
  success: 'border-(--color-success)/30 bg-(--color-success-subtle) text-(--accent-green-text)',
  warning: 'border-(--color-warning)/30 bg-(--color-warning-subtle) text-(--accent-orange-text)',
  error: 'border-(--color-error)/25 bg-(--color-error-subtle) text-(--color-error)',
}

const ICON: Record<Tone, typeof Info> = {
  neutral: Info,
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
}

interface CalloutProps {
  tone?: Tone
  /** Bold first line. */
  title?: ReactNode
  children?: ReactNode
  /** Controls under the text (e.g. Connect OAuth). */
  action?: ReactNode
  /** `status` for passive notices, `alert` for failures that need attention. */
  role?: 'status' | 'alert'
  className?: string
}

export function Callout({ tone = 'neutral', title, children, action, role, className }: CalloutProps) {
  const Icon = ICON[tone]
  return (
    <div role={role} className={cn('flex gap-3 rounded-sm border px-4 py-3 text-xs leading-relaxed', TONE[tone], className)}>
      <Icon size={ICON_SIZE} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className="font-medium text-(--color-text)">{title}</p>}
        {children && <div>{children}</div>}
        {action && <div className="pt-1.5">{action}</div>}
      </div>
    </div>
  )
}
