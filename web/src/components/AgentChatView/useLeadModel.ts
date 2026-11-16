/**
 * The lead agent and the model this session runs on: the agent (and its
 * capabilities, which drive the composer's slash menu), whether a message
 * can run at all, and when the context is summarized.
 */
import { useMemo } from 'react'
import type { AgentCapabilities as AgentCapabilitiesType } from '@/api/types'
import { modelReadiness } from '@/lib/model-readiness'
import { useProvidersQuery } from '@/queries'
import { useRegistryQuery } from '@/queries/useAgentSettingsQueries'
import { useAgentsQuery } from '@/queries/useAgentsQuery'

export function useLeadModel(workspace: string | null, sessionModel: string | null) {
  const providersQ = useProvidersQuery()
  const { data: agentRegistryData, isLoading: agentRegistryLoading } = useAgentsQuery(workspace, Boolean(workspace))
  const leadAgent = agentRegistryData?.agents?.[0]
  const leadCapabilities: AgentCapabilitiesType | undefined = leadAgent?.capabilities
  // Can a message run? A real model whose provider is connected. Unknown
  // while either list loads, so no setup prompt flashes on a working setup.
  const modelReady = modelReadiness(
    providersQ.data?.providers,
    agentRegistryData ? (sessionModel || leadAgent?.model || null) : undefined,
  )
  const needsModelSetup = modelReady.status === 'needs-model' || modelReady.status === 'needs-provider'

  // When the session overrides the agent's model (e.g. user switches from
  // model A to model B mid-session), the trigger threshold must reflect the
  // *active* model, not the agent config model.  Look up the session model in
  // the registry; fall back to the lead agent's pre-computed value.
  const { data: registryData } = useRegistryQuery()
  const summaryTriggerTokens = useMemo(() => {
    if (sessionModel) {
      const entry = registryData?.models?.find((m) => m.id === sessionModel)
      if (entry?.summary_trigger_tokens) return entry.summary_trigger_tokens
    }
    return leadAgent?.summary_trigger_tokens
  }, [sessionModel, registryData, leadAgent])

  return {
    providersData: providersQ.data,
    agentRegistryLoading,
    leadAgent,
    leadCapabilities,
    modelReady,
    needsModelSetup,
    summaryTriggerTokens,
  }
}
