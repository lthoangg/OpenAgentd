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
import { SettingsRow } from '@/components/settings/SettingsRow'
import { SettingsSection } from '@/components/settings/SettingsSection'
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
      description="Let agents in one workspace ask sessions in another, such as an infrastructure repo."
      draft={draft}
      loading={messagesQ.isLoading}
      error={messagesQ.error}
    >
      <SettingsSection title="Messages" flush>
        <SettingsRow
          label="Let agents message other workspaces"
          htmlFor="workspaces-messages"
          description="Turning this off removes the tool from new turns; replies already on their way still arrive."
        >
          <Switch
            id="workspaces-messages"
            checked={draft.value.enabled}
            onCheckedChange={(checked) => draft.patch({ enabled: checked })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Groups"
        description="Repositories in the same group can message each other; Chat reaches every one. Changes save right away."
        flush
      >
        <WorkspaceGroupsSettings />
      </SettingsSection>
    </SettingsPage>
  )
}
