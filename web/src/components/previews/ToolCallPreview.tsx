/**
 * ToolCallPreview — composite preview that mirrors the lifecycle
 * matrix in `.diagrams/OpenAgentd-ui.pen` (`W0qCF`/`sLqLL`):
 *
 *   1. Start         — name only, muted dot
 *   2. Running       — args visible, pulsing orange dot
 *   3. End · Success — green dot, result body
 *   4. End · Failed  — red dot, error result body
 *
 * Each variant maps to a real `ToolCall` invocation so the preview
 * stays in sync with the component's failure-detection heuristics
 * (`isFailedResult`).
 */

import { ToolCall } from '@/components/ToolCall'

function PreviewFrame({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-sm border border-(--color-border) bg-(--bg-page) p-4">
      <div className="mb-2">
        <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-(--color-text-2)">
          {title}
        </h3>
        <p className="text-xs text-(--color-text-muted)">{description}</p>
      </div>
      {children}
    </div>
  )
}

export function ToolCallPreview() {
  return (
    <section className="grid gap-5 rounded-sm border border-(--color-border) bg-(--bg-card) p-5 text-(--color-text)">
      <div>
        <h2 className="font-heading text-3xl font-bold">ToolCall lifecycle</h2>
        <p className="text-sm text-(--color-text-2)">
          Four canonical states a tool invocation passes through.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <PreviewFrame
          title="1 · Start"
          description="Tool name announced before any arguments stream in."
        >
          <ToolCall name="shell" />
        </PreviewFrame>

        <PreviewFrame
          title="2 · Running"
          description="Arguments visible; pulsing orange dot signals work in flight."
        >
          <ToolCall
            name="shell"
            args={JSON.stringify({ command: 'pytest --no-cov -q tests/api/test_streams.py' })}
          />
        </PreviewFrame>

        <PreviewFrame
          title="3 · End · Success"
          description="Done with a clean result — green status dot."
        >
          <ToolCall
            name="shell"
            args={JSON.stringify({ command: 'pytest --no-cov -q tests/api/test_streams.py' })}
            done
            result={'..........\n10 passed in 0.42s'}
          />
        </PreviewFrame>

        <PreviewFrame
          title="4 · End · Failed"
          description="Result begins with a failure marker — red status dot."
        >
          <ToolCall
            name="shell"
            args={JSON.stringify({ command: 'pytest --no-cov -q tests/api/test_streams.py' })}
            done
            result={'[Failed] exit code 1\nFAILED tests/api/test_streams.py::test_sse_close — AssertionError'}
          />
        </PreviewFrame>
      </div>
    </section>
  )
}
