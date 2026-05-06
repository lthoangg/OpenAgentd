import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { Root, NotFound } from './routes/__root'
import { HomePage } from './routes/index'
import { TeamLayout } from './routes/cockpit'
import { SettingsLayout } from './routes/settings'
import { SettingsHubPage } from './routes/settings.index'
import { AgentsListPage } from './routes/settings.agents'
import { AgentEditorPage } from './routes/settings.agents.$name'
import { NewAgentPage } from './routes/settings.agents.new'
import { SkillsListPage } from './routes/settings.skills'
import { SkillEditorPage } from './routes/settings.skills.$name'
import { NewSkillPage } from './routes/settings.skills.new'
import { McpListPage } from './routes/settings.mcp'
import { NewMcpServerPage } from './routes/settings.mcp.new'
import { McpServerDetailPage } from './routes/settings.mcp.$name'
import { SandboxSettingsPage } from './routes/settings.sandbox'
import { DreamSettingsPage } from './routes/settings.dream'
import { VoiceSettingsPage } from './routes/settings.voice'
import { TelemetryPage } from './routes/telemetry'
import { SchedulerPage } from './routes/scheduler'

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

// /settings/dream
const settingsDreamRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: 'dream',
  component: DreamSettingsPage,
})

// /settings/voice
const settingsVoiceRoute = createRoute({
  getParentRoute: () => settingsLayoutRoute,
  path: 'voice',
  component: VoiceSettingsPage,
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
    settingsDreamRoute,
    settingsVoiceRoute,
  ]),
  telemetryRoute,
  schedulerRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
