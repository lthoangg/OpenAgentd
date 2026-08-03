import { CommandPalette } from '../CommandPalette'
import { SchedulerPanel } from '../SchedulerPanel'
import { SessionSettingsPanel } from '../SessionSettingsPanel'
import { TodosPopover } from '../TodosPopover'
import type { TodoItem, WorkspaceFileInfo } from '@/api/types'
import type { Command } from '../CommandPalette'

interface TeamChatPanelsProps {
  agentCapabilitiesOpen: boolean
  agentWorkspace: string | null
  sessionModel: string | null
  sessionThinkingLevel: string | null
  onSessionModelSettingsChange: (model: string | null, thinkingLevel: string | null) => void
  onCloseAgentCapabilities: () => void
  mode: 'normal' | 'coding'
  isMobile: boolean
  showTodos: boolean
  onShowTodosChange: (open: boolean) => void
  todos: TodoItem[]
  sessionId: string | null
  schedulerOpen: boolean
  onCloseScheduler: () => void
  workspace: string | null
  showPalette: boolean
  paletteCommands: Command[]
  paletteWorkspaceFiles: WorkspaceFileInfo[]
  onPaletteFileOpen: (file: WorkspaceFileInfo) => void
  onClosePalette: () => void
}

export function TeamChatPanels({
  agentCapabilitiesOpen,
  agentWorkspace,
  sessionModel,
  sessionThinkingLevel,
  onSessionModelSettingsChange,
  onCloseAgentCapabilities,
  mode,
  isMobile,
  showTodos,
  onShowTodosChange,
  todos,
  sessionId,
  schedulerOpen,
  onCloseScheduler,
  workspace,
  showPalette,
  paletteCommands,
  paletteWorkspaceFiles,
  onPaletteFileOpen,
  onClosePalette,
}: TeamChatPanelsProps) {
  return (
    <>
      <SessionSettingsPanel
        open={agentCapabilitiesOpen}
        workspace={agentWorkspace}
        sessionModel={sessionModel}
        sessionThinkingLevel={sessionThinkingLevel}
        onSessionModelSettingsChange={onSessionModelSettingsChange}
        onClose={onCloseAgentCapabilities}
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
        <CommandPalette commands={paletteCommands} workspaceFiles={paletteWorkspaceFiles} onFileOpen={onPaletteFileOpen} onClose={onClosePalette} />
      )}
    </>
  )
}
