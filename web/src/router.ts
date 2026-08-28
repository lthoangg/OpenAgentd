import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router'
import { lazyRouteComponent } from '@tanstack/react-router'
import { z } from 'zod'
import { Root, NotFound } from './routes/__root'
import { CodingLayout } from './routes/cockpit'

const rootRoute = createRootRoute({
  component: Root,
  notFoundComponent: NotFound,
})

// / → Coding workspace
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/coding' })
  },
})

// Tauri's packaged asset URL may surface as /index.html before the root
// effect canonicalizes it. Render Coding immediately instead of flashing the
// not-found screen on a first desktop launch.
const packagedIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/index.html',
  component: CodingLayout,
})

// /coding layout — coding mode without query-string mode state
const codingLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/coding',
  component: CodingLayout,
})
const codingIndexRoute = createRoute({
  getParentRoute: () => codingLayoutRoute,
  path: '/',
  component: () => null,
})
const codingSessionRoute = createRoute({
  getParentRoute: () => codingLayoutRoute,
  path: '$sessionId',
  component: () => null,
})

const telemetrySearchSchema = z.object({
  days: z.number().optional(),
  traceId: z.string().optional(),
})

const schedulerSearchSchema = z.object({
  q: z.string().optional(),
  task: z.string().optional(),
})

// /telemetry — standalone observability page (span aggregates & latency)
const telemetryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/telemetry',
  validateSearch: (search) => telemetrySearchSchema.parse(search),
  component: lazyRouteComponent(() => import('./routes/telemetry'), 'TelemetryPage'),
})

// /scheduler — standalone scheduler page (manage scheduled tasks)
const schedulerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/scheduler',
  validateSearch: (search) => schedulerSearchSchema.parse(search),
  component: lazyRouteComponent(() => import('./routes/scheduler'), 'SchedulerPage'),
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  packagedIndexRoute,
  codingLayoutRoute.addChildren([codingIndexRoute, codingSessionRoute]),
  telemetryRoute,
  schedulerRoute,
])

export const router = createRouter({ routeTree, defaultPreload: 'intent' })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
