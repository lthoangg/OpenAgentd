/**
 * useRunSettings — everything the run deck and the run picker show about how
 * the next message runs: the model, its thinking level, the account, and the
 * choices for each. One place, so the chip and the picker can never disagree.
 */
import { useEffect, useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useShallow } from 'zustand/react/shallow'

import type { ModelCatalogEntry } from '@/api/types'
import type { ProviderInfo, StoredCredential } from '@/api/client'
import { queryKeys, useProvidersQuery } from '@/queries'
import { useAgentsQuery } from '@/queries/useAgentsQuery'
import { useRegistryQuery } from '@/queries/useAgentSettingsQueries'
import { accountChoices, accountInUse, effectiveRun, splitModelId } from '@/lib/run-settings'
import { pickableThinkingLevels } from '@/lib/thinking-levels'
import { useAgentStore } from '@/stores/useAgentStore'
import { turnAccount } from '@/utils/turns'

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
  /** Levels to pick from, lowest first; empty while they are not known or there is no choice. */
  thinkingLevels: string[]
  /** Chat models the picker lists (no image or video generators). */
  models: ModelCatalogEntry[]
  /** The list is still the placeholder built from the providers list: its rows carry no levels. */
  modelsLoading: boolean
  providerInfo: ProviderInfo | undefined
  /** The accounts to choose from, or `null` when the provider has one. */
  accounts: StoredCredential[] | null
  /** The account the session is locked to (it starts there); `null` when it has none. */
  credentialId: string | null
  pinnedAccount: StoredCredential | null
  /**
   * The account the session runs on (see `accountInUse`): the lock while it
   * has room, else the one it moved to. `null` when there is no choice.
   */
  inUseAccount: StoredCredential | null
}

/** The newest account the lead's transcript names: an answer's, or a switch's. */
function selectServedLabel(s: ReturnType<typeof useAgentStore.getState>): string | null {
  const stream = s.leadName ? s.agentStreams[s.leadName] : undefined
  if (!stream) return null
  return turnAccount(stream.currentBlocks ?? []) ?? turnAccount(stream.blocks ?? []) ?? null
}

export function useRunSettings(workspace: string | null): RunSettings {
  const session = useAgentStore(useShallow((s) => ({
    model: s.sessionModel,
    thinkingLevel: s.sessionThinkingLevel,
    credentialId: s.sessionCredentialId,
  })))
  const servedLabel = useAgentStore(selectServedLabel)
  // A switch (or an answer on another account) changes which accounts are
  // cooling and which one is in use: read the accounts again.
  const queryClient = useQueryClient()
  const lastServed = useRef(servedLabel)
  useEffect(() => {
    if (lastServed.current === servedLabel) return
    lastServed.current = servedLabel
    void queryClient.invalidateQueries({ queryKey: queryKeys.settings.providers() })
  }, [queryClient, servedLabel])
  const agents = useAgentsQuery(workspace, Boolean(workspace))
  const agent = agents.data?.agents?.[0]
  const registry = useRegistryQuery()
  const providers = useProvidersQuery()
  const modelsLoading = registry.isLoading || registry.isPlaceholderData

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
    const inUseAccount = accountInUse(accounts, session.credentialId, servedLabel)
    return {
      agentName: agent?.name ?? null,
      agentModel,
      agentThinkingLevel,
      model: run.model,
      provider,
      thinkingLevel: run.thinkingLevel,
      customized: run.overridden || Boolean(session.thinkingLevel) || Boolean(session.credentialId),
      thinkingLevels: pickableThinkingLevels(entry, !modelsLoading),
      models,
      modelsLoading,
      providerInfo,
      accounts,
      credentialId: session.credentialId,
      pinnedAccount,
      inUseAccount,
    }
  }, [agent, session, servedLabel, registry.data, modelsLoading, providers.data])
}
