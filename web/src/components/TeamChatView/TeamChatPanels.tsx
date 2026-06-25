import { CommandPalette } from '../CommandPalette'
import { SchedulerPanel } from '../SchedulerPanel'
import { SessionSettingsPanel } from '../SessionSettingsPanel'
import { TodosPopover } from '../TodosPopover'
import { WorkspaceFilesPanel } from '../WorkspaceFilesPanel'
import type { TodoItem } from '@/api/types'
import type { Command } from '../CommandPalette'

interface TeamChatPanelsProps {
  agentCapabilitiesOpen: boolean
  agentNames: string[]
  agentWorkspace: string | null
  sessionModel: string | null
  sessionThinkingLevel: string | null
  sessionFastMode: boolean
  onSessionModelSettingsChange: (model: string | null, thinkingLevel: string | null, fastMode: boolean) => void
  onCloseAgentCapabilities: () => void
  mode: 'normal' | 'coding'
  showFilesPanel: boolean
  sessionId: string | null
  onCloseFilesPanel: () => void
  isMobile: boolean
  showTodos: boolean
  onShowTodosChange: (open: boolean) => void
  todos: TodoItem[]
  schedulerOpen: boolean
  onCloseScheduler: () => void
  workspace: string | null
  showPalette: boolean
  paletteCommands: Command[]
  onClosePalette: () => void
}

export function TeamChatPanels({
  agentCapabilitiesOpen,
  agentNames,
  agentWorkspace,
  sessionModel,
  sessionThinkingLevel,
  sessionFastMode,
  onSessionModelSettingsChange,
  onCloseAgentCapabilities,
  mode,
  showFilesPanel,
  sessionId,
  onCloseFilesPanel,
  isMobile,
  showTodos,
  onShowTodosChange,
  todos,
  schedulerOpen,
  onCloseScheduler,
  workspace,
  showPalette,
  paletteCommands,
  onClosePalette,
}: TeamChatPanelsProps) {
  return (
    <>
      <SessionSettingsPanel
        open={agentCapabilitiesOpen}
        agentNames={agentNames}
        workspace={agentWorkspace}
        sessionModel={sessionModel}
        sessionThinkingLevel={sessionThinkingLevel}
        sessionFastMode={sessionFastMode}
        onSessionModelSettingsChange={onSessionModelSettingsChange}
        onClose={onCloseAgentCapabilities}
      />
      <WorkspaceFilesPanel
        open={mode !== 'coding' && showFilesPanel}
        sessionId={sessionId}
        onClose={onCloseFilesPanel}
      />
      <TodosPopover
        open={isMobile && showTodos}
        onOpenChange={onShowTodosChange}
        todos={todos}
        sessionId={sessionId}
        trigger={false}
      />
      <SchedulerPanel
        open={schedulerOpen}
        onClose={onCloseScheduler}
        contextMode={mode}
        contextWorkspace={workspace ?? null}
      />
      {showPalette && (
        <CommandPalette commands={paletteCommands} onClose={onClosePalette} />
      )}
    </>
  )
}
