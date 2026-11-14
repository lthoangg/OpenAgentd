/**
 * AppErrorBoundary — root render-crash guard.
 *
 * In the Tauri shells there is no address bar or refresh button: an uncaught
 * render error would leave the user staring at a dead webview until they
 * force-quit the app. This boundary catches the crash, shows a recovery
 * screen consistent with `AppLoadingScreen`, and offers Reload + a copyable
 * error report.
 *
 * Must stay dependency-light (no store/query imports) — anything it pulls in
 * is code that can no longer crash independently of the boundary itself.
 */

import { Component, type ReactNode } from 'react'
import { Seal } from '@/components/brand/Logo'
import { Button } from '@/components/ui/button'

// Its own copy of the labels: this file imports almost nothing (see above).
const COPY_LABEL = { idle: 'Copy error details', copied: 'Copied', failed: 'Could not copy' } as const

interface AppErrorBoundaryProps {
  children: ReactNode
  /** Injection point for tests; defaults to a full page reload. */
  reload?: () => void
}

interface AppErrorBoundaryState {
  error: Error | null
  copy: 'idle' | 'copied' | 'failed'
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null, copy: 'idle' }

  static getDerivedStateFromError(error: Error): Partial<AppErrorBoundaryState> {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('AppErrorBoundary caught render error', error, info.componentStack)
  }

  private handleReload = () => {
    if (this.props.reload) {
      this.props.reload()
      return
    }
    window.location.reload()
  }

  private handleCopy = () => {
    const { error } = this.state
    if (!error) return
    const details = `${error.message}\n\n${error.stack ?? ''}`.trim()
    // No clipboard, or it refused (a webview without focus or permission).
    const written = navigator.clipboard?.writeText(details) ?? Promise.reject(new Error('no clipboard'))
    void written.then(() => this.setState({ copy: 'copied' }), () => this.setState({ copy: 'failed' }))
  }

  render() {
    const { error, copy } = this.state
    if (error === null) return this.props.children

    return (
      <div className="mobile-safe-shell mobile-viewport flex h-dvh items-center justify-center bg-(--bg-page)" role="alert">
        <div className="flex max-w-sm flex-col items-center gap-5 px-6 text-center">
          <Seal size={88} className="text-(--color-text)" />
          <div className="flex flex-col gap-1.5">
            <h1 className="text-base font-semibold text-(--color-text)">Something went wrong</h1>
            <p className="text-sm text-(--color-text-muted)">
              The app hit an unexpected error and could not continue.
            </p>
            <p className="mt-1 max-h-24 overflow-y-auto rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2 text-left font-mono text-xs break-words text-(--color-text-2)">
              {error.message}
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={this.handleReload}>Reload</Button>
            <Button variant="ghost" onClick={this.handleCopy}>
              {COPY_LABEL[copy]}
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
