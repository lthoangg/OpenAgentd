import { motion } from 'framer-motion'
import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { OPENAGENTD_APP_ICON } from '@/lib/brand-assets'

import { AppBackendDialog } from '@/components/AppBackendDialog'
import { Activity, AlertCircle, Code2, Wifi } from 'lucide-react'
import { useHealthQuery } from '@/queries/useHealthQuery'
import { usePlatform } from '@/hooks/use-platform'
import { useIsMobile } from '@/hooks/use-mobile'
import { useTauriDrag } from '@/hooks/use-tauri-drag'
import { useReducedMotion } from '@/hooks/useReducedMotion'

export function HomePage() {
  const navigate = useNavigate()
  const health = useHealthQuery()
  // The home page is a splash screen with no AppHeader — without an
  // explicit drag region the user can't move the window on macOS Tauri
  // (the OS draws traffic-lights over the WebView but doesn't provide
  // drag elsewhere). MacTitleBar already covers the 70px traffic-light
  // inset; this strip extends the drag area across the rest of the top
  // edge. Other platforms have a native OS title bar so the strip is
  // gated to ``isMacOverlay``.
  const isMobile = useIsMobile()
  const { isMacOverlay, isTauri, os } = usePlatform()
  const isTauriMobile = isMobile && isTauri && (os === 'ios' || os === 'android')
  const dragHandlers = useTauriDrag()
  const prefersReducedMotion = useReducedMotion()
  const [backendDialogOpen, setBackendDialogOpen] = useState(false)

  const backendOk = health.isSuccess
  const loading = health.isLoading
  const error = health.isError

  const openCodingMode = () => {
    navigate({ to: '/coding' })
  }

  return (
    <main id="main" className="mobile-safe-shell mobile-viewport flex h-dvh flex-col overflow-y-auto bg-(--bg-page) px-4">
      {isMacOverlay && (
        <div
          {...dragHandlers}
          aria-hidden="true"
          className="fixed left-(--spacing-mac-traffic-inset) right-0 top-0 z-20 h-10 select-none"
        />
      )}
      <motion.div
        initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 24 }}
        animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
        transition={{ duration: prefersReducedMotion ? 0.01 : 0.45, ease: 'easeOut' }}
        className={`mx-auto flex w-full max-w-sm flex-1 flex-col items-center justify-center ${isTauriMobile ? 'gap-5 py-[max(1.25rem,env(safe-area-inset-top))]' : 'gap-7 py-6'}`}
      >
        {/* Logo */}
        <div className={`flex select-none flex-col items-center ${isTauriMobile ? 'gap-3' : 'gap-4'}`}>
          <div className="relative">
            <div className="absolute inset-0 rounded-2xl bg-(--bg-key) blur-2xl" />
            <div className={`relative flex items-center justify-center rounded-2xl border border-(--color-border) bg-(--bg-card) shadow-sm ${isTauriMobile ? 'h-16 w-16' : 'h-20 w-20'}`}>
              <img src={OPENAGENTD_APP_ICON} width={isTauriMobile ? 58 : 72} height={isTauriMobile ? 58 : 72} alt="OpenAgentd logo" className="rounded-xl" />
            </div>
          </div>
          <div className="text-center">
            <h1 className={`font-sans font-semibold leading-none tracking-tight text-(--color-text) ${isTauriMobile ? 'text-4xl' : 'text-5xl'}`}>
              OpenAgentd
            </h1>
            <p className="mt-1 text-sm text-(--color-text-muted)">
              Your on-machine AI assistant
            </p>
          </div>
        </div>

        {/* Mode picker */}
        <div className={`flex flex-col ${isTauriMobile ? 'w-[min(100%,21rem)] gap-2.5' : 'w-full gap-3'}`}>
          <ModeCard
            icon={Code2}
            title="Coding"
            description="Use a project workspace"
            disabled={!backendOk}
            loading={loading && !error}
            compact={isTauriMobile}
            onClick={openCodingMode}
          />
           <ModeCard
             icon={Activity}
             title="Telemetry"
             description="Span aggregates & latency"
             disabled={!backendOk}
             loading={loading && !error}
             compact={isTauriMobile}
             onClick={() => navigate({ to: '/telemetry' })}
           />
        </div>

        {/* Backend status */}
        <div className="flex items-center gap-2 text-xs">
          {loading && !error ? (
            <button
              type="button"
              onClick={() => setBackendDialogOpen(true)}
              className="flex items-center gap-2 rounded-sm border border-transparent px-2 py-1 text-(--color-text-muted) transition-colors hover:border-(--color-border) hover:bg-(--bg-card) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40"
            >
              <Wifi size={12} className="animate-pulse" />
              <span>Connecting…</span>
              <span>Choose server</span>
            </button>
          ) : error ? (
            <button
              type="button"
              onClick={() => setBackendDialogOpen(true)}
              className="flex items-center gap-2 rounded-sm border border-transparent px-2 py-1 text-(--color-error) transition-colors hover:border-(--color-error)/25 hover:bg-(--color-error)/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40"
            >
              <AlertCircle size={12} />
              <span>Backend unreachable</span>
              <span className="text-(--color-text-muted)">Choose server</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setBackendDialogOpen(true)}
              className="flex items-center gap-2 rounded-sm border border-transparent px-2 py-1 transition-colors hover:border-(--color-border) hover:bg-(--bg-card) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40"
            >
              <Wifi size={12} className="text-(--color-success)" />
              <span className="text-(--color-text-muted)">Connected</span>
              <span className="text-(--color-text-muted)">Change server</span>
            </button>
          )}
        </div>
      </motion.div>
      <AppBackendDialog open={backendDialogOpen} onOpenChange={setBackendDialogOpen} />
    </main>
  )
}

function ModeCard({
  icon: Icon,
  title,
  description,
  disabled,
  loading,
  compact = false,
  onClick,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  title: string
  description: string
  disabled: boolean
  loading: boolean
  compact?: boolean
  onClick: () => void
}) {
  return (
    <motion.button
      whileHover={disabled ? {} : { scale: 1.015 }}
      whileTap={disabled ? {} : { scale: 0.985 }}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={`flex w-full items-center rounded-sm border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 ${compact ? 'gap-3 px-3 py-2.5' : 'gap-3 px-4 py-3'} ${
        disabled
          ? 'cursor-not-allowed border-(--color-border) bg-(--bg-card) opacity-45'
          : 'border-(--color-border) bg-(--bg-card) hover:border-(--color-border-strong) hover:bg-(--bg-key)/40'
      }`}
    >
      <div
        className={`flex shrink-0 items-center justify-center rounded-sm border ${compact ? 'h-8 w-8' : 'h-9 w-9'} ${
          disabled
            ? 'border-(--color-border) bg-(--bg-input)'
            : 'border-(--color-border) bg-(--bg-key)/60'
        }`}
      >
        <Icon
          size={compact ? 15 : 16}
          className={
            disabled
              ? 'text-(--color-text-muted)'
              : loading
                ? 'animate-pulse text-(--color-accent)'
                : 'text-(--color-accent)'
          }
        />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-(--color-text)">{title}</p>
        <p className={`text-xs text-(--color-text-muted) ${compact ? 'mt-0 truncate' : 'mt-0.5'}`}>{description}</p>
      </div>
    </motion.button>
  )
}
