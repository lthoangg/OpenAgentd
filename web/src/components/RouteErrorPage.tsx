/**
 * The router's page for an error in a route (``defaultErrorComponent``), in
 * the app's words and buttons rather than the router's built-in box: Try
 * again renders the route afresh, Reload restarts the app.
 */
import { Button } from '@/components/ui/button'
import { ErrorNotice, errorOf } from '@/components/ErrorNotice'

export function RouteErrorPage({ error, reset }: { error: unknown; reset: () => void }) {
  return (
    <div className="mobile-safe-shell mobile-viewport flex h-dvh items-center justify-center bg-(--bg-page)">
      <ErrorNotice
        heading="h1"
        title="Something went wrong"
        description="This screen hit an unexpected error."
        error={errorOf(error)}
        actions={(
          <>
            <Button onClick={reset}>Try again</Button>
            <Button variant="ghost" onClick={() => window.location.reload()}>Reload</Button>
          </>
        )}
      />
    </div>
  )
}
