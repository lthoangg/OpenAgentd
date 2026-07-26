import { useEffect, useId, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { CodeBlock } from '@/components/CodeBlock'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useThemePreference } from '@/hooks/useThemePreference'

interface MermaidBlockProps {
  source: string
  highlightedCode: React.ReactNode
}

type RenderState =
  | { status: 'loading'; svg?: string }
  | { status: 'ready'; svg: string }
  | { status: 'error' }

let renderQueue = Promise.resolve()
let renderSequence = 0

async function renderDiagram(id: string, source: string, theme: 'light' | 'dark'): Promise<string> {
  let svg = ''
  const task = renderQueue.then(async () => {
    const { default: mermaid } = await import('mermaid')
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: theme === 'dark' ? 'dark' : 'default',
    })
    const result = await mermaid.render(`${id}-${++renderSequence}`, source)
    svg = result.svg
  })
  renderQueue = task.catch(() => undefined)
  await task
  return svg
}

export function MermaidBlock({ source, highlightedCode }: MermaidBlockProps) {
  const [view, setView] = useState('diagram')
  const [renderState, setRenderState] = useState<RenderState>({ status: 'loading' })
  const { resolved: theme } = useThemePreference()
  const reactId = useId()
  const renderId = `oa-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`

  useEffect(() => {
    if (view !== 'diagram') return

    let active = true
    setRenderState((current) => ({
      status: 'loading',
      svg: current.status === 'ready' ? current.svg : undefined,
    }))

    void renderDiagram(renderId, source, theme)
      .then((svg) => {
        if (active) setRenderState({ status: 'ready', svg })
      })
      .catch(() => {
        if (active) setRenderState({ status: 'error' })
      })

    return () => {
      active = false
    }
  }, [renderId, source, theme, view])

  return (
    <div className="surface-raised my-1.5 overflow-hidden rounded-md border border-(--color-border) bg-(--bg-card)">
      <Tabs value={view} onValueChange={setView} className="gap-0">
        <div className="flex min-h-10 items-center border-b border-(--color-border) bg-(--bg-key) px-1.5">
          <TabsList aria-label="Mermaid block view" className="h-8 border-0 bg-transparent p-0">
            <TabsTrigger value="diagram" className="min-h-8 px-2.5 text-xs">Diagram</TabsTrigger>
            <TabsTrigger value="code" className="min-h-8 px-2.5 text-xs">Code</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="diagram" className="m-0">
          {renderState.status === 'error' ? (
            <div>
              <div role="alert" className="flex items-center gap-2 px-3 py-2.5 text-xs text-(--color-error)">
                <AlertCircle size={14} aria-hidden="true" />
                Could not render this Mermaid diagram. The source is shown below.
              </div>
              <CodeBlock language="mermaid" rawText={source}>{highlightedCode}</CodeBlock>
            </div>
          ) : (
            <div className="oa-mermaid-diagram" aria-busy={renderState.status === 'loading'}>
              {renderState.svg ? (
                <div dangerouslySetInnerHTML={{ __html: renderState.svg }} />
              ) : (
                <div className="px-3 py-8 text-center text-xs text-(--color-text-muted)">
                  Rendering diagram...
                </div>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="code" className="m-0 [&>div]:m-0 [&>div]:rounded-none [&>div]:border-0">
          <CodeBlock language="mermaid" rawText={source}>{highlightedCode}</CodeBlock>
        </TabsContent>
      </Tabs>
    </div>
  )
}
