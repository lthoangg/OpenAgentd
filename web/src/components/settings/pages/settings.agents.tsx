import { AgentEditorPage } from './settings.agents.$name'

/** The product has one configurable agent, stored at agents/code.md. */
export function AgentsListPage() {
  return <AgentEditorPage onBack={() => undefined} />
}
