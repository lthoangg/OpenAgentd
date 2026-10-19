import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { Root, NotFound } from './routes/__root'
import { AppLayout } from './routes/cockpit'
import { SchedulerPage } from './routes/scheduler'
import { TelemetryPage } from './routes/telemetry'

const rootRoute = createRootRoute({
  component: Root,
  notFoundComponent: NotFound,
})

// Tauri's packaged asset URL may surface as /index.html before the root
// effect canonicalizes it. Render the app immediately instead of flashing the
// not-found screen on a first desktop launch.
const packagedIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/index.html',
  component: AppLayout,
})

// The one screen: / is a new session, /<id> a session. A pathless layout so
// switching sessions keeps the chat view mounted. `/?workspace=<path>` is a
// new-session draft in that folder; nothing is saved until its first message.
const appLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  component: AppLayout,
})
const newSessionSearchSchema = z.object({
  // A path that parses as JSON (a bare number) is not a folder: drop it.
  workspace: z.string().min(1).optional().catch(undefined),
})
const newSessionRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/',
  validateSearch: (search) => newSessionSearchSchema.parse(search),
  component: () => null,
})
const sessionRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '$sessionId',
  component: () => null,
})

// Links from older builds (bookmarks, notifications, other windows) used a
// /coding prefix; they redirect and render nothing of their own.
const legacyCodingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/coding',
  beforeLoad: () => {
    throw redirect({ to: '/', replace: true })
  },
})
const legacyCodingSessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/coding/$sessionId',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/$sessionId', params: { sessionId: params.sessionId }, replace: true })
  },
})

const telemetrySearchSchema = z.object({
  days: z.number().optional(),
  traceId: z.string().optional(),
  session: z.string().optional(),
})

const schedulerSearchSchema = z.object({
  q: z.string().optional(),
  task: z.string().optional(),
})

// /telemetry — deep-link shim: opens the telemetry overlay, then /
const telemetryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/telemetry',
  validateSearch: (search) => telemetrySearchSchema.parse(search),
  component: TelemetryPage,
})

// /scheduler — standalone scheduler page (manage scheduled tasks)
const schedulerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/scheduler',
  validateSearch: (search) => schedulerSearchSchema.parse(search),
  component: SchedulerPage,
})

const routeTree = rootRoute.addChildren([
  packagedIndexRoute,
  appLayoutRoute.addChildren([newSessionRoute, sessionRoute]),
  legacyCodingRoute,
  legacyCodingSessionRoute,
  telemetryRoute,
  schedulerRoute,
])

export const router = createRouter({ routeTree, defaultPreload: 'intent' })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
