import { TerminalView } from '../Terminal/TerminalView'

interface TerminalSubPanelProps {
  termId: string
  workspace?: string
}

export function TerminalSubPanel({ termId }: TerminalSubPanelProps) {
  return (
    <div className="h-full p-1.5">
      <TerminalView key={termId} sessionId={termId} />
    </div>
  )
}
