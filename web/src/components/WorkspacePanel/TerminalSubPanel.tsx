import { useIsMobile } from '@/hooks/use-mobile'
import { TerminalView } from '../Terminal/TerminalView'

interface TerminalSubPanelProps {
  termId: string
}

export function TerminalSubPanel({ termId }: TerminalSubPanelProps) {
  // A phone keeps every column: the terminal's own 4px inset is the margin.
  const isMobile = useIsMobile()
  return (
    <div className={isMobile ? 'h-full' : 'h-full p-1.5'}>
      <TerminalView key={termId} sessionId={termId} />
    </div>
  )
}
