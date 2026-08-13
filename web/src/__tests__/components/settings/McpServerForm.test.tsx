import { describe, it, expect, afterEach, mock } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { McpServerForm } from '@/components/settings/McpServerForm'
import { emptyDraft, type McpServerDraft } from '@/components/settings/McpServerDraft'

// Mock lucide-react icons to avoid SVG issues in Happy DOM
mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

afterEach(cleanup)

// ── Helpers ──────────────────────────────────────────────────────────────────

function renderForm(
  value: McpServerDraft,
  onChange: (next: McpServerDraft) => void,
  props?: { isNew?: boolean; disabled?: boolean; errors?: Record<string, string> | null },
) {
  return render(
    <McpServerForm
      value={value}
      onChange={onChange}
      isNew={props?.isNew}
      disabled={props?.disabled}
      errors={props?.errors}
    />,
  )
}

// ── Identity section ─────────────────────────────────────────────────────────

describe('McpServerForm — Identity section', () => {
  it('renders name input with value', () => {
    const draft = { ...emptyDraft(), name: 'filesystem' }
    const onChange = mock(() => {})
    renderForm(draft, onChange, { isNew: true })
    const input = screen.getByDisplayValue('filesystem')
    expect(input).toBeTruthy()
  })

  it('disables name input when isNew is false', () => {
    const draft = { ...emptyDraft(), name: 'filesystem' }
    const onChange = mock(() => {})
    renderForm(draft, onChange, { isNew: false })
    const input = screen.getByDisplayValue('filesystem') as HTMLInputElement
    expect(input.disabled).toBe(true)
  })

  it('enables name input when isNew is true', () => {
    const draft = { ...emptyDraft(), name: 'filesystem' }
    const onChange = mock(() => {})
    renderForm(draft, onChange, { isNew: true })
    const input = screen.getByDisplayValue('filesystem') as HTMLInputElement
    expect(input.disabled).toBe(false)
  })

  it('calls onChange with new name when name input changes', async () => {
    const user = userEvent.setup()
    const draft = emptyDraft()
    const onChange = mock(() => {})
    renderForm(draft, onChange, { isNew: true })
    const input = screen.getByPlaceholderText('filesystem') as HTMLInputElement
    await user.clear(input)
    await user.type(input, 'myserver')
    expect(onChange).toHaveBeenCalled()
  })

  it('renders enabled toggle with current state', () => {
    const draft = { ...emptyDraft(), enabled: true }
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    const enabledBtn = screen.getByRole('radio', { name: /enabled/i })
    expect(enabledBtn).toBeTruthy()
  })

  it('calls onChange with enabled=true when Enabled button is clicked', async () => {
    const user = userEvent.setup()
    const draft = { ...emptyDraft(), enabled: false }
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    const enabledBtn = screen.getByRole('radio', { name: /enabled/i })
    await user.click(enabledBtn)
    expect(onChange).toHaveBeenCalled()
  })

  it('calls onChange with enabled=false when Disabled button is clicked', async () => {
    const user = userEvent.setup()
    const draft = { ...emptyDraft(), enabled: true }
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    const disabledBtn = screen.getByRole('radio', { name: /disabled/i })
    await user.click(disabledBtn)
    expect(onChange).toHaveBeenCalled()
  })

  it('associates the name control with its authoritative error', () => {
    const draft = emptyDraft()
    const onChange = mock(() => {})
    renderForm(draft, onChange, { errors: { name: 'Name is required.' } })
    const input = screen.getByPlaceholderText('filesystem') as HTMLInputElement
    const error = screen.getByText('Name is required.')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe(error.id)
    expect(error.id).toBeTruthy()
  })
})

// ── Transport tabs ───────────────────────────────────────────────────────────

describe('McpServerForm — Transport tabs', () => {
  it('renders both stdio and http tabs', () => {
    const draft = emptyDraft()
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    expect(screen.getByRole('radio', { name: /stdio/i })).toBeTruthy()
    expect(screen.getByRole('radio', { name: /http/i })).toBeTruthy()
  })

  it('shows stdio section when transport is stdio', () => {
    const draft = { ...emptyDraft(), transport: 'stdio' as const }
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    expect(screen.getByText(/Transport — Stdio/i)).toBeTruthy()
    expect(screen.getByPlaceholderText('npx')).toBeTruthy()
  })

  it('shows http section when transport is http', () => {
    const draft = { ...emptyDraft(), transport: 'http' as const }
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    expect(screen.getByText(/Transport — HTTP/i)).toBeTruthy()
    expect(screen.getByPlaceholderText('https://mcp.example.com/v1')).toBeTruthy()
  })

  it('switches to http tab when http tab is clicked', async () => {
    const user = userEvent.setup()
    const draft = { ...emptyDraft(), transport: 'stdio' as const }
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    const httpTab = screen.getByRole('radio', { name: /http/i })
    await user.click(httpTab)
    expect(onChange).toHaveBeenCalled()
  })

  it('switches to stdio tab when stdio tab is clicked', async () => {
    const user = userEvent.setup()
    const draft = { ...emptyDraft(), transport: 'http' as const }
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    const stdioTab = screen.getByRole('radio', { name: /stdio/i })
    await user.click(stdioTab)
    expect(onChange).toHaveBeenCalled()
  })

  it('preserves both transports fields when switching tabs', async () => {
    const user = userEvent.setup()
    let draft: McpServerDraft = {
      ...emptyDraft(),
      transport: 'stdio' as const,
      command: 'npx',
      url: 'https://example.com',
    }
    const onChange = mock(((next: McpServerDraft) => {
      draft = next
    }) as (...args: unknown[]) => unknown)
    renderForm(draft, onChange)
    const httpTab = screen.getByRole('radio', { name: /http/i })
    await user.click(httpTab)
    expect(onChange).toHaveBeenCalled()
  })
})

// ── Stdio section ────────────────────────────────────────────────────────────

describe('McpServerForm — Stdio section', () => {
  it('renders command input with value', () => {
    const draft = { ...emptyDraft(), transport: 'stdio' as const, command: 'npx' }
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    expect(screen.getByDisplayValue('npx')).toBeTruthy()
  })

  it('calls onChange when command input changes', async () => {
    const user = userEvent.setup()
    const draft = { ...emptyDraft(), transport: 'stdio' as const }
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    const input = screen.getByPlaceholderText('npx') as HTMLInputElement
    await user.type(input, 'python')
    expect(onChange).toHaveBeenCalled()
  })

  it('associates the command control with its authoritative error', () => {
    const draft = { ...emptyDraft(), transport: 'stdio' as const }
    const onChange = mock(() => {})
    renderForm(draft, onChange, { errors: { command: 'Command is required.' } })
    const input = screen.getByPlaceholderText('npx') as HTMLInputElement
    const error = screen.getByText('Command is required.')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe(error.id)
    expect(error.id).toBeTruthy()
  })

  it('renders arguments textarea with value', () => {
    const draft = {
      ...emptyDraft(),
      transport: 'stdio' as const,
      argsText: '@modelcontextprotocol/server-filesystem\n/tmp',
    }
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    expect(screen.getByDisplayValue(/@modelcontextprotocol/)).toBeTruthy()
  })

  it('calls onChange when arguments textarea changes', async () => {
    const user = userEvent.setup()
    const draft = { ...emptyDraft(), transport: 'stdio' as const }
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    const textarea = screen.getByPlaceholderText(/-y/) as HTMLTextAreaElement
    await user.type(textarea, 'arg1')
    expect(onChange).toHaveBeenCalled()
  })

  it('renders environment variables section', () => {
    const draft = { ...emptyDraft(), transport: 'stdio' as const }
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    expect(screen.getByText(/Environment variables/i)).toBeTruthy()
  })

  it('associates environment inputs with their authoritative error', () => {
    const draft = {
      ...emptyDraft(),
      transport: 'stdio' as const,
      envPairs: [{ key: 'KEY', value: 'value' }],
    }
    const onChange = mock(() => {})
    renderForm(draft, onChange, { errors: { env: 'Duplicate environment variable: KEY' } })
    const keyInput = screen.getByDisplayValue('KEY') as HTMLInputElement
    const valueInput = screen.getByDisplayValue('value') as HTMLInputElement
    const error = screen.getByText(/Duplicate environment variable/)
    expect(keyInput.getAttribute('aria-describedby')).toBe(error.id)
    expect(valueInput.getAttribute('aria-describedby')).toBe(error.id)
    expect(error.id).toBeTruthy()
  })
})

// ── HTTP section ─────────────────────────────────────────────────────────────

describe('McpServerForm — HTTP section', () => {
  it('renders url input with value', () => {
    const draft = { ...emptyDraft(), transport: 'http' as const, url: 'https://example.com' }
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    expect(screen.getByDisplayValue('https://example.com')).toBeTruthy()
  })

  it('calls onChange when url input changes', async () => {
    const user = userEvent.setup()
    const draft = { ...emptyDraft(), transport: 'http' as const }
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    const input = screen.getByPlaceholderText(/https:\/\/mcp/) as HTMLInputElement
    await user.type(input, 'https://example.com')
    expect(onChange).toHaveBeenCalled()
  })

  it('associates the URL control with its authoritative error', () => {
    const draft = { ...emptyDraft(), transport: 'http' as const }
    const onChange = mock(() => {})
    renderForm(draft, onChange, { errors: { url: 'URL is required.' } })
    const input = screen.getByPlaceholderText(/https:\/\/mcp/) as HTMLInputElement
    const error = screen.getByText('URL is required.')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe(error.id)
    expect(error.id).toBeTruthy()
  })

  it('renders headers section', () => {
    const draft = { ...emptyDraft(), transport: 'http' as const }
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    expect(screen.getByText(/Headers/i)).toBeTruthy()
  })

  it('associates header inputs with their authoritative error', () => {
    const draft = {
      ...emptyDraft(),
      transport: 'http' as const,
      headerPairs: [{ key: 'X-Custom', value: 'value' }],
    }
    const onChange = mock(() => {})
    renderForm(draft, onChange, { errors: { headers: 'Duplicate header: X-Custom' } })
    const keyInput = screen.getByDisplayValue('X-Custom') as HTMLInputElement
    const valueInput = screen.getByDisplayValue('value') as HTMLInputElement
    const error = screen.getByText(/Duplicate header/)
    expect(keyInput.getAttribute('aria-describedby')).toBe(error.id)
    expect(valueInput.getAttribute('aria-describedby')).toBe(error.id)
    expect(error.id).toBeTruthy()
  })
})

// ── Pair list field (env vars, headers) ──────────────────────────────────────

describe('McpServerForm — Pair list field', () => {
  it('renders "None." when no pairs exist', () => {
    const draft = { ...emptyDraft(), transport: 'stdio' as const, envPairs: [] }
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    expect(screen.getByText('None.')).toBeTruthy()
  })

  it('renders pair rows when pairs exist', () => {
    const draft = {
      ...emptyDraft(),
      transport: 'stdio' as const,
      envPairs: [
        { key: 'KEY1', value: 'val1' },
        { key: 'KEY2', value: 'val2' },
      ],
    }
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    expect(screen.getByDisplayValue('KEY1')).toBeTruthy()
    expect(screen.getByDisplayValue('KEY2')).toBeTruthy()
  })

  it('calls onChange when pair key changes', async () => {
    const user = userEvent.setup()
    const draft = {
      ...emptyDraft(),
      transport: 'stdio' as const,
      envPairs: [{ key: 'KEY', value: 'val' }],
    }
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    const keyInput = screen.getByDisplayValue('KEY') as HTMLInputElement
    await user.clear(keyInput)
    await user.type(keyInput, 'NEWKEY')
    expect(onChange).toHaveBeenCalled()
  })

  it('calls onChange when pair value changes', async () => {
    const user = userEvent.setup()
    const draft = {
      ...emptyDraft(),
      transport: 'stdio' as const,
      envPairs: [{ key: 'KEY', value: 'val' }],
    }
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    const valueInput = screen.getByDisplayValue('val') as HTMLInputElement
    await user.clear(valueInput)
    await user.type(valueInput, 'newval')
    expect(onChange).toHaveBeenCalled()
  })

  it('renders Add button for pair list', () => {
    const draft = { ...emptyDraft(), transport: 'stdio' as const }
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    const addBtn = screen.getByRole('button', { name: /add environment variables/i })
    expect(addBtn).toBeTruthy()
  })

  it('calls onChange with new empty pair when Add button is clicked', async () => {
    const user = userEvent.setup()
    const draft = {
      ...emptyDraft(),
      transport: 'stdio' as const,
      envPairs: [{ key: 'KEY1', value: 'val1' }],
    }
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    const addBtn = screen.getByRole('button', { name: /add environment variables/i })
    await user.click(addBtn)
    expect(onChange).toHaveBeenCalled()
  })

  it('renders Remove button for each pair', () => {
    const draft = {
      ...emptyDraft(),
      transport: 'stdio' as const,
      envPairs: [
        { key: 'KEY1', value: 'val1' },
        { key: 'KEY2', value: 'val2' },
      ],
    }
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    const removeButtons = screen.getAllByRole('button', { name: /remove/i })
    expect(removeButtons.length).toBeGreaterThanOrEqual(2)
  })

  it('calls onChange with pair removed when Remove button is clicked', async () => {
    const user = userEvent.setup()
    const draft = {
      ...emptyDraft(),
      transport: 'stdio' as const,
      envPairs: [
        { key: 'KEY1', value: 'val1' },
        { key: 'KEY2', value: 'val2' },
      ],
    }
    const onChange = mock(() => {})
    renderForm(draft, onChange)
    const removeButtons = screen.getAllByRole('button', { name: /remove/i })
    await user.click(removeButtons[0])
    expect(onChange).toHaveBeenCalled()
  })
})

// ── Disabled state ───────────────────────────────────────────────────────────

describe('McpServerForm — Disabled state', () => {
  it('disables all inputs when disabled=true', () => {
    const draft = { ...emptyDraft(), transport: 'stdio' as const, command: 'cmd' }
    const onChange = mock(() => {})
    renderForm(draft, onChange, { disabled: true })
    const inputs = screen.getAllByRole('textbox')
    for (const input of inputs) {
      expect((input as HTMLInputElement).disabled).toBe(true)
    }
  })

  it('disables Add button when disabled=true', () => {
    const draft = { ...emptyDraft(), transport: 'stdio' as const }
    const onChange = mock(() => {})
    renderForm(draft, onChange, { disabled: true })
    const addBtn = screen.getByRole('button', { name: /add environment variables/i })
    expect((addBtn as HTMLButtonElement).disabled).toBe(true)
  })
})
