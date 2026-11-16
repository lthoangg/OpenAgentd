/**
 * Settings → Workspaces — whether lead agents may message sessions in other
 * workspaces, and the groups that decide which workspaces may reach each
 * other. Everything here applies at once, the switch as the groups do, so
 * the page has no save bar.
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
import { failureToast } from '@/lib/failure-toast'
import { useToastStore } from '@/stores/useToastStore'

export function WorkspacesSettingsPage() {
  const messagesQ = useWorkspaceMessagesSettingsQuery()
  const updateMessages = useUpdateWorkspaceMessagesSettingsMutation()
  const push = useToastStore((s) => s.push)
  // While a change is on its way, show where it is going.
  const enabled = updateMessages.isPending
    ? updateMessages.variables.enabled
    : messagesQ.data?.enabled ?? true

  return (
    <SettingsPage
      title="Workspaces"
      description="Let agents in one workspace ask sessions in another, such as your infrastructure workspace."
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
            checked={enabled}
            disabled={updateMessages.isPending}
            onCheckedChange={(checked) => updateMessages.mutate(
              { enabled: checked },
              { onError: (err) => push(failureToast("Couldn't save", err)) },
            )}
          />
        </PanelRow>
      </PanelSection>

      <PanelSection
        title="Groups"
        description="Workspaces in the same group can message each other. Chat, the workspace for sessions without a folder, reaches every one."
        flush
      >
        <WorkspaceGroupsSettings />
      </PanelSection>
    </SettingsPage>
  )
}
