/**
 * useRunSettings — everything the run deck and the run picker show about how
 * the next message runs: the model, its thinking level, the account, and the
 * choices for each. One place, so the chip and the picker can never disagree.
 */
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'

import type { ModelCatalogEntry } from '@/api/types'
import type { ProviderInfo, StoredCredential } from '@/api/client'
import { useProvidersQuery } from '@/queries'
import { useAgentsQuery } from '@/queries/useAgentsQuery'
import { useRegistryQuery } from '@/queries/useAgentSettingsQueries'
import { accountChoices, effectiveRun, splitModelId } from '@/lib/run-settings'
import { supportedThinkingLevels } from '@/lib/thinking-levels'
import { useAgentStore } from '@/stores/useAgentStore'

export interface RunSettings {
  /** The lead agent's file name (`code` unless the workspace overrides it). */
  agentName: string | null
  agentModel: string | null
  agentThinkingLevel: string | null
  /** What the next message runs with. */
  model: string | null
  provider: string
  thinkingLevel: string | null
  /** The session overrides any of model, level or account. */
  customized: boolean
  /** Levels the model supports, lowest first. */
  thinkingLevels: string[]
  /** Chat models the picker lists (no image or video generators). */
  models: ModelCatalogEntry[]
  modelsLoading: boolean
  providerInfo: ProviderInfo | undefined
  /** The accounts to choose from, or `null` when the provider has one. */
  accounts: StoredCredential[] | null
  /** The pinned account; `null` is Auto. */
  credentialId: string | null
  pinnedAccount: StoredCredential | null
}

export function useRunSettings(workspace: string | null): RunSettings {
  const session = useAgentStore(useShallow((s) => ({
    model: s.sessionModel,
    thinkingLevel: s.sessionThinkingLevel,
    credentialId: s.sessionCredentialId,
  })))
  const agents = useAgentsQuery(workspace, Boolean(workspace))
  const agent = agents.data?.agents?.[0]
  const registry = useRegistryQuery()
  const providers = useProvidersQuery()

  return useMemo(() => {
    const agentModel = agent?.model ?? null
    const agentThinkingLevel = agent?.thinking_level ?? null
    const run = effectiveRun(session, { model: agentModel, thinkingLevel: agentThinkingLevel })
    const models = (registry.data?.models ?? []).filter((m) => !m.output_image && !m.output_video)
    const entry = models.find((m) => m.id === run.model)
    const provider = run.model ? splitModelId(run.model).provider : ''
    const providerInfo = providers.data?.providers.find((p) => p.id === provider)
    const accounts = accountChoices(providerInfo)
    const pinnedAccount = session.credentialId
      ? (providerInfo?.stored_credentials ?? []).find((c) => c.id === session.credentialId) ?? null
      : null
    return {
      agentName: agent?.name ?? null,
      agentModel,
      agentThinkingLevel,
      model: run.model,
      provider,
      thinkingLevel: run.thinkingLevel,
      customized: run.overridden || Boolean(session.thinkingLevel) || Boolean(session.credentialId),
      thinkingLevels: supportedThinkingLevels(entry),
      models,
      modelsLoading: registry.isLoading,
      providerInfo,
      accounts,
      credentialId: session.credentialId,
      pinnedAccount,
    }
  }, [agent, session, registry.data, registry.isLoading, providers.data])
}
