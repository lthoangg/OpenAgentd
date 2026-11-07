/**
 * ViewErrorBoundary — a crash in the chat column or the Review panel shows a
 * recovery panel in their place, so the header, the sidebar and the status
 * bar keep working: open another session, Settings, or try the view again.
 * Another session (``resetKey``) renders the view afresh, as Try again does.
 */
import { Component, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/ErrorNotice'

interface ViewErrorBoundaryProps {
  children: ReactNode
  /** The view's identity (the session): a new one clears the error. */
  resetKey?: unknown
}

interface ViewErrorBoundaryState {
  error: Error | null
  resetKey: unknown
}

export class ViewErrorBoundary extends Component<ViewErrorBoundaryProps, ViewErrorBoundaryState> {
  state: ViewErrorBoundaryState = { error: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: Error): Partial<ViewErrorBoundaryState> {
    return { error }
  }

  static getDerivedStateFromProps(props: ViewErrorBoundaryProps, state: ViewErrorBoundaryState): Partial<ViewErrorBoundaryState> | null {
    return Object.is(props.resetKey, state.resetKey) ? null : { error: null, resetKey: props.resetKey }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('ViewErrorBoundary caught render error', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (error === null) return this.props.children
    return (
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-(--bg-page)">
        <ErrorNotice
          title="Couldn't show this view"
          description="Something in it failed to render. The sidebar still works: try again, or open another session."
          error={error}
          actions={<Button onClick={() => this.setState({ error: null })}>Try again</Button>}
        />
      </div>
    )
  }
}
