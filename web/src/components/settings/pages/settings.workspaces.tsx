/**
 * Settings → Workspaces — whether lead agents may message sessions in other
 * workspaces, and the groups that decide which workspaces may reach each
 * other. Groups save at once; the messages switch uses the save bar.
 */
import {
  useUpdateWorkspaceMessagesSettingsMutation,
  useWorkspaceMessagesSettingsQuery,
} from '@/queries'
import { Switch } from '@/components/ui/switch'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { WorkspaceGroupsSettings } from '@/components/settings/WorkspaceGroupsSettings'
import { useSettingsDraft } from '@/components/settings/useSettingsDraft'
import type { WorkspaceMessagesSettings } from '@/api/client'

const WORKSPACE_MESSAGES_DEFAULT: WorkspaceMessagesSettings = { enabled: true }

export function WorkspacesSettingsPage() {
  const messagesQ = useWorkspaceMessagesSettingsQuery()
  const updateMessages = useUpdateWorkspaceMessagesSettingsMutation()

  const draft = useSettingsDraft({
    data: messagesQ.data,
    initial: WORKSPACE_MESSAGES_DEFAULT,
    onSave: (value) => updateMessages.mutateAsync(value),
    successTitle: 'Workspace message settings saved',
  })

  return (
    <SettingsPage
      title="Workspaces"
      description="Let agents in one workspace ask sessions in another, such as your infrastructure workspace."
      draft={draft}
      loading={messagesQ.isLoading}
      error={messagesQ.error}
    >
      <PanelSection title="Messages" flush>
        <PanelRow
          label="Let agents message other workspaces"
          htmlFor="workspaces-messages"
          description="Turning this off removes the tool from new turns; replies already on their way still arrive."
        >
          <Switch
            id="workspaces-messages"
            checked={draft.value.enabled}
            onCheckedChange={(checked) => draft.patch({ enabled: checked })}
          />
        </PanelRow>
      </PanelSection>

      <PanelSection
        title="Groups"
        description="Workspaces in the same group can message each other. Chat, the workspace for sessions without a folder, reaches every one. Changes save right away."
        flush
      >
        <WorkspaceGroupsSettings />
      </PanelSection>
    </SettingsPage>
  )
}
