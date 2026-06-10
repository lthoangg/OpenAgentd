import { lazy } from 'react'
import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { Root, NotFound } from './routes/__root'

const HomePage = lazy(() => import('./routes/index').then((mod) => ({ default: mod.HomePage })))
const TeamLayout = lazy(() => import('./routes/cockpit').then((mod) => ({ default: mod.TeamLayout })))
const CodingLayout = lazy(() => import('./routes/cockpit').then((mod) => ({ default: mod.CodingLayout })))
const SettingsLayout = lazy(() => import('./routes/settings').then((mod) => ({ default: mod.SettingsLayout })))
const SettingsHubPage = lazy(() => import('./routes/settings.index').then((mod) => ({ default: mod.SettingsHubPage })))
const AgentsListPage = lazy(() => import('./routes/settings.agents').then((mod) => ({ default: mod.AgentsListPage })))
const AgentEditorPage = lazy(() => import('./routes/settings.agents.$name').then((mod) => ({ default: mod.AgentEditorPage })))
const NewAgentPage = lazy(() => import('./routes/settings.agents.new').then((mod) => ({ default: mod.NewAgentPage })))
const SkillsListPage = lazy(() => import('./routes/settings.skills').then((mod) => ({ default: mod.SkillsListPage })))
const SkillEditorPage = lazy(() => import('./routes/settings.skills.$name').then((mod) => ({ default: mod.SkillEditorPage })))
const NewSkillPage = lazy(() => import('./routes/settings.skills.new').then((mod) => ({ default: mod.NewSkillPage })))
const McpListPage = lazy(() => import('./routes/settings.mcp').then((mod) => ({ default: mod.McpListPage })))
const NewMcpServerPage = lazy(() => import('./routes/settings.mcp.new').then((mod) => ({ default: mod.NewMcpServerPage })))
const McpServerDetailPage = lazy(() => import('./routes/settings.mcp.$name').then((mod) => ({ default: mod.McpServerDetailPage })))
const SandboxSettingsPage = lazy(() => import('./routes/settings.sandbox').then((mod) => ({ default: mod.SandboxSettingsPage })))
const ProvidersSettingsPage = lazy(() => import('./routes/settings.providers').then((mod) => ({ default: mod.ProvidersSettingsPage })))
const MultimodalSettingsPage = lazy(() => import('./routes/settings.multimodal').then((mod) => ({ default: mod.MultimodalSettingsPage })))
const DreamSettingsPage = lazy(() => import('./routes/settings.dream').then((mod) => ({ default: mod.DreamSettingsPage })))
const TitleGenerationSettingsPage = lazy(() => import('./routes/settings.title-generation').then((mod) => ({ default: mod.TitleGenerationSettingsPage })))
const NotificationSettingsPage = lazy(() => import('./routes/settings.notifications').then((mod) => ({ default: mod.NotificationSettingsPage })))
const TelemetryPage = lazy(() => import('./routes/telemetry').then((mod) => ({ default: mod.TelemetryPage })))
const SchedulerPage = lazy(() => import('./routes/scheduler').then((mod) => ({ default: mod.SchedulerPage })))

const rootRoute = createRootRoute({
  component: Root,
  notFoundComponent: NotFound,
})

// / → Home (mode picker)
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePage,
})

// /cockpit layout — persists across /cockpit and /cockpit/$sessionId
const teamLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/cockpit',
  component: TeamLayout,
})
const teamIndexRoute = createRoute({
  getParentRoute: () => teamLayoutRoute,
  path: '/',
  component: () => null,
})
const teamSessionRoute = createRoute({
  getParentRoute: () => teamLayoutRoute,
  path: '$sessionId',
  component: () => null,
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

// /settings — hub of cards
const settingsLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsLayout,
})
const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: '/',
  component: SettingsHubPage,
})

// /settings/agents
const settingsAgentsRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: 'agents',
  component: AgentsListPage,
})
const settingsAgentsNewRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: 'agents/new',
  component: NewAgentPage,
})
const settingsAgentDetailRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: 'agents/$name',
  component: AgentEditorPage,
})

// /settings/skills
const settingsSkillsRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: 'skills',
  component: SkillsListPage,
})
const settingsSkillsNewRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: 'skills/new',
  component: NewSkillPage,
})
const settingsSkillDetailRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: 'skills/$name',
  component: SkillEditorPage,
})

// /settings/mcp
const settingsMcpRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: 'mcp',
  component: McpListPage,
})
const settingsMcpNewRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: 'mcp/new',
  component: NewMcpServerPage,
})
const settingsMcpDetailRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: 'mcp/$name',
  component: McpServerDetailPage,
})

// /settings/sandbox
const settingsSandboxRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: 'sandbox',
  component: SandboxSettingsPage,
})

// /settings/providers
const settingsProvidersRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: 'providers',
  component: ProvidersSettingsPage,
})

const settingsMultimodalRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: 'multimodal',
  component: MultimodalSettingsPage,
})

// /settings/dream
const settingsDreamRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: 'dream',
  component: DreamSettingsPage,
})

const settingsTitleGenerationRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: 'title-generation',
  component: TitleGenerationSettingsPage,
})

// /settings/notifications
const settingsNotificationsRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: 'notifications',
  component: NotificationSettingsPage,
})

// /telemetry — standalone observability page (span aggregates & latency)
const telemetryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/telemetry',
  component: TelemetryPage,
})

// /scheduler — standalone scheduler page (manage scheduled tasks)
const schedulerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/scheduler',
  component: SchedulerPage,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  teamLayoutRoute.addChildren([teamIndexRoute, teamSessionRoute]),
  codingLayoutRoute.addChildren([codingIndexRoute, codingSessionRoute]),
  settingsLayoutRoute.addChildren([
    settingsIndexRoute,
    settingsAgentsRoute,
    settingsAgentsNewRoute,
    settingsAgentDetailRoute,
    settingsSkillsRoute,
    settingsSkillsNewRoute,
    settingsSkillDetailRoute,
    settingsMcpRoute,
    settingsMcpNewRoute,
    settingsMcpDetailRoute,
    settingsSandboxRoute,
    settingsProvidersRoute,
    settingsMultimodalRoute,
    settingsDreamRoute,
    settingsTitleGenerationRoute,
    settingsNotificationsRoute,
  ]),
  telemetryRoute,
  schedulerRoute,
])

export const router = createRouter({ routeTree, defaultPreload: 'intent' })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
