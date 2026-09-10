import { describe, it, expect, mock } from 'bun:test'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MarkdownBlock } from '@/utils/markdown'
import { normalizeProposedPlanTags, PlanActionContext } from '@/utils/markdown-plan'

describe('normalizeProposedPlanTags', () => {
  it('returns untouched content if no proposed_plan tag exists', () => {
    const text = 'Just some regular text'
    expect(normalizeProposedPlanTags(text)).toBe(text)
  })

  it('splits inline <proposed_plan> and </proposed_plan> onto their own lines', () => {
    const text = 'Here is the plan: <proposed_plan>## Step 1</proposed_plan> that is all.'
    const normalized = normalizeProposedPlanTags(text)
    expect(normalized).toContain('Here is the plan:\n\n<proposed_plan>\n')
    expect(normalized).toContain('\n</proposed_plan>\n\nthat is all.')
  })

  it('leaves <proposed_plan> untouched when wrapped in inline backticks', () => {
    const text = 'Finish with a structured `<proposed_plan>` block:'
    expect(normalizeProposedPlanTags(text)).toBe(text)
  })

  it('leaves <proposed_plan> and </proposed_plan> untouched when wrapped in backticks', () => {
    const text = 'Wrap your plan in `<proposed_plan>` and `</proposed_plan>` tags.'
    expect(normalizeProposedPlanTags(text)).toBe(text)
  })

  it('leaves plan untouched when wrapped in inline backticks', () => {
    const text = '`Here is <proposed_plan>## Step 1</proposed_plan>`'
    expect(normalizeProposedPlanTags(text)).toBe(text)
  })

  it('leaves <proposed_plan> untouched inside fenced code blocks', () => {
    const text = '```xml\n<proposed_plan>\n## Summary\n</proposed_plan>\n```'
    expect(normalizeProposedPlanTags(text)).toBe(text)
  })

  it('normalizes un-backticked tags while preserving backticked tags in mixed content', () => {
    const text = 'Use `<proposed_plan>`: Here is the plan: <proposed_plan>## Step 1</proposed_plan> that is all.'
    const normalized = normalizeProposedPlanTags(text)
    expect(normalized).toContain('Use `<proposed_plan>`:')
    expect(normalized).toContain('\n\n<proposed_plan>\n## Step 1\n</proposed_plan>\n\nthat is all.')
  })
})

describe('MarkdownBlock <proposed_plan> rendering', () => {
  it('renders a styled plan divider instead of raw XML tags', () => {
    const content = `
I investigated the problem. Here is the plan:

<proposed_plan>
## Summary
Fix the database timeout bug.

## Sequential steps
1. Inspect connection pool.
2. Increase keepalive threshold.
</proposed_plan>

Let me know if this looks good.
`
    const { container } = render(<MarkdownBlock content={content} />)

    const planDivider = container.querySelector('[data-testid="proposed-plan-divider"]')
    expect(planDivider).not.toBeNull()
    expect(planDivider?.textContent).toContain('Proposed plan')
    expect(planDivider?.textContent).toContain('Summary')
    expect(planDivider?.textContent).toContain('Fix the database timeout bug.')
    expect(planDivider?.textContent).toContain('Sequential steps')

    // Raw tags must not be visible in rendered output
    expect(container.textContent).not.toContain('<proposed_plan>')
    expect(container.textContent).not.toContain('</proposed_plan>')

    // Prose before and after must render
    expect(container.textContent).toContain('I investigated the problem')
    expect(container.textContent).toContain('Let me know if this looks good')
  })

  it('renders inner markdown elements properly inside the plan divider', () => {
    const content = `
<proposed_plan>
### Phase 1
- Step A
- Step B
</proposed_plan>
`
    const { container } = render(<MarkdownBlock content={content} />)
    const planDivider = container.querySelector('[data-testid="proposed-plan-divider"]')
    expect(planDivider).not.toBeNull()
    const h3 = planDivider?.querySelector('h3')
    expect(h3).not.toBeNull()
    expect(h3?.textContent).toContain('Phase 1')
    const listItems = planDivider?.querySelectorAll('li')
    expect(listItems?.length).toBe(2)
  })

  it('gracefully handles streaming unclosed <proposed_plan>', () => {
    const streamingContent = `
<proposed_plan>
## In-flight Plan
Streaming step 1...
`
    const { container } = render(<MarkdownBlock content={streamingContent} isStreaming />)
    const planDivider = container.querySelector('[data-testid="proposed-plan-divider"]')
    expect(planDivider).not.toBeNull()
    expect(planDivider?.textContent).toContain('In-flight Plan')
    expect(container.textContent).not.toContain('<proposed_plan>')
  })

  it('renders Option A embedded action on the closing divider when onStartImplementing is provided', async () => {
    const onStartImplementing = mock(() => {})
    const content = `
<proposed_plan>
## Summary
Ready to go.
</proposed_plan>
`
    const { container } = render(
      <PlanActionContext.Provider value={{ onStartImplementing }}>
        <MarkdownBlock content={content} />
      </PlanActionContext.Provider>,
    )
    const planDivider = container.querySelector('[data-testid="proposed-plan-divider"]')
    expect(planDivider).not.toBeNull()
    const button = planDivider?.querySelector('button')
    expect(button).not.toBeNull()
    expect(button?.textContent).toContain('Approve')

    await userEvent.click(button!)
    expect(onStartImplementing).toHaveBeenCalledTimes(1)
  })

  it('renders normal markdown code and no plan divider when <proposed_plan> is wrapped in backticks', () => {
    const content = 'Finish with a structured `<proposed_plan>` block:'
    const { container } = render(<MarkdownBlock content={content} />)

    const planDivider = container.querySelector('[data-testid="proposed-plan-divider"]')
    expect(planDivider).toBeNull()

    const code = container.querySelector('code')
    expect(code).not.toBeNull()
    expect(code?.textContent).toBe('<proposed_plan>')
  })

  it('renders normal markdown code and no plan divider when entire plan is wrapped in backticks', () => {
    const content = '`<proposed_plan>## Step 1</proposed_plan>`'
    const { container } = render(<MarkdownBlock content={content} />)

    const planDivider = container.querySelector('[data-testid="proposed-plan-divider"]')
    expect(planDivider).toBeNull()

    const code = container.querySelector('code')
    expect(code).not.toBeNull()
    expect(code?.textContent).toContain('<proposed_plan>## Step 1</proposed_plan>')
  })

  it('renders fenced code block and no plan divider when inside a fenced code block', () => {
    const content = '```xml\n<proposed_plan>\n## Summary\nFix the bug\n</proposed_plan>\n```'
    const { container } = render(<MarkdownBlock content={content} />)

    const planDivider = container.querySelector('[data-testid="proposed-plan-divider"]')
    expect(planDivider).toBeNull()

    const pre = container.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre?.textContent).toContain('<proposed_plan>')
  })

  it('renders both inline code and plan divider in mixed content', () => {
    const content = `
Finish with a \`<proposed_plan>\` block:

<proposed_plan>
## Summary
Fix the bug.
</proposed_plan>
`
    const { container } = render(<MarkdownBlock content={content} />)

    const code = container.querySelector('code')
    expect(code).not.toBeNull()
    expect(code?.textContent).toBe('<proposed_plan>')

    const planDivider = container.querySelector('[data-testid="proposed-plan-divider"]')
    expect(planDivider).not.toBeNull()
    expect(planDivider?.textContent).toContain('Summary')
    expect(planDivider?.textContent).toContain('Fix the bug.')
  })

  it('does not prematurely close plan divider when plan body mentions </proposed_plan> in backticks', () => {
    const content = `
<proposed_plan>
## Note
Remember to close with \`</proposed_plan>\`.

## Final Step
Done.
</proposed_plan>
`
    const { container } = render(<MarkdownBlock content={content} />)
    const planDivider = container.querySelector('[data-testid="proposed-plan-divider"]')
    expect(planDivider).not.toBeNull()
    expect(planDivider?.textContent).toContain('Final Step')
    expect(planDivider?.textContent).toContain('Done.')
  })
})
