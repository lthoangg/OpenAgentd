import { describe, it, expect, afterEach, mock, beforeEach } from 'bun:test'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { create } from 'zustand'
import { VoiceMicButton } from '@/components/VoiceMicButton'

afterEach(cleanup)

// ── Mocks ─────────────────────────────────────────────────────────────────────

// postTranscribe is called by the component — mock the module.
const mockPostTranscribe = mock(async (audioBlob: Blob) => {
  const formData = new FormData()
  formData.append('file', new File([audioBlob], 'recording.webm', { type: audioBlob.type }))

  const res = await fetch('http://localhost/api/speech/transcribe', {
    method: 'POST',
    body: formData,
  })

  if (!res.ok) {
    let detail = `POST /speech/transcribe failed: ${res.status}`
    try {
      const body = await res.json()
      if (typeof body?.detail === 'string') detail = body.detail
    } catch {
      // Keep fallback.
    }
    throw new Error(detail)
  }

  return res.json()
})

mock.module('@/api/client', () => ({
  postTranscribe: mockPostTranscribe,
}))

// useToastStore — capture pushed toasts.
const pushedToasts: Array<{ tone: string; title: string; description?: string }> = []
const mockPush = mock((t: { tone: string; title: string; description?: string }) => {
  pushedToasts.push(t)
})

const useToastStoreMock = create<{
  toasts: Array<{ id: string; tone: string; title: string; description?: string }>
  push: typeof mockPush
  dismiss: (id: string) => void
}>()((set) => ({
  toasts: [],
  push: (t) => {
    mockPush(t)
    set((state) => ({
      toasts: [
        ...state.toasts,
        { id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ...t },
      ],
    }))
  },
  dismiss: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }))
  },
}))

mock.module('@/stores/useToastStore', () => ({
  useToastStore: useToastStoreMock,
}))

// MediaRecorder stub — not available in Happy DOM.
class MockMediaRecorder extends EventTarget {
  mimeType = 'audio/webm'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null

  start() {
    // Immediately fire a data chunk
    this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) })
  }

  stop() {
    this.onstop?.()
  }
}

// getUserMedia stub
function makeStreamStub() {
  return {
    getTracks: () => [{ stop: mock(() => {}) }],
  }
}

beforeEach(() => {
  pushedToasts.length = 0
  mockPostTranscribe.mockReset()
  mockPush.mockReset()
  useToastStoreMock.setState({ toasts: [] })

  // Reset to successful default
  mockPostTranscribe.mockImplementation(async () => ({ text: 'hello world' }))

  // Install MediaRecorder + getUserMedia stubs
  ;(global as Record<string, unknown>).MediaRecorder = MockMediaRecorder
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: mock(async () => makeStreamStub()) },
    configurable: true,
    writable: true,
  })
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('VoiceMicButton — disabled state', () => {
  it('renders with MicOff icon when voice is disabled', () => {
    render(<VoiceMicButton voiceEnabled={false} onTranscript={() => {}} />)
    const btn = screen.getByLabelText('Voice input disabled')
    expect(btn).toBeTruthy()
  })

  it('button is disabled when voiceEnabled is false', () => {
    render(<VoiceMicButton voiceEnabled={false} onTranscript={() => {}} />)
    const btn = screen.getByLabelText('Voice input disabled') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('shows the disabled tooltip', () => {
    render(<VoiceMicButton voiceEnabled={false} onTranscript={() => {}} />)
    const btn = screen.getByLabelText('Voice input disabled')
    expect(btn.getAttribute('title')).toContain('Voice mode is disabled')
    expect(btn.getAttribute('title')).toContain('settings')
  })

  it('exact disabled tooltip text matches spec', () => {
    render(<VoiceMicButton voiceEnabled={false} onTranscript={() => {}} />)
    const btn = screen.getByLabelText('Voice input disabled')
    expect(btn.getAttribute('title')).toBe(
      'Voice mode is disabled. Enable it in settings to use voice input.'
    )
  })
})

describe('VoiceMicButton — idle state', () => {
  it('renders Mic icon when idle and enabled', () => {
    render(<VoiceMicButton voiceEnabled={true} onTranscript={() => {}} />)
    const btn = screen.getByLabelText('Start voice input')
    expect(btn).toBeTruthy()
  })

  it('button is enabled when voiceEnabled is true', () => {
    render(<VoiceMicButton voiceEnabled={true} onTranscript={() => {}} />)
    const btn = screen.getByLabelText('Start voice input') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('button is disabled when disabled prop is true', () => {
    render(<VoiceMicButton voiceEnabled={true} onTranscript={() => {}} disabled={true} />)
    const btn = screen.getByLabelText('Start voice input') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })
})

describe('VoiceMicButton — recording state', () => {
  it('transitions to recording state on click', async () => {
    const user = userEvent.setup()
    render(<VoiceMicButton voiceEnabled={true} onTranscript={() => {}} />)

    const btn = screen.getByLabelText('Start voice input')
    await user.click(btn)

    await waitFor(() => {
      expect(screen.getByLabelText('Stop recording')).toBeTruthy()
    })
  })

  it('has data-recording attribute set when recording', async () => {
    const user = userEvent.setup()
    render(<VoiceMicButton voiceEnabled={true} onTranscript={() => {}} />)

    await user.click(screen.getByLabelText('Start voice input'))

    await waitFor(() => {
      const btn = screen.getByLabelText('Stop recording')
      expect(btn.getAttribute('data-recording')).toBe('true')
    })
  })
})

describe('VoiceMicButton — transcript insertion', () => {
  it('calls onTranscript with transcribed text on stop', async () => {
    const user = userEvent.setup()
    let captured = ''
    const onTranscript = (t: string) => { captured = t }

    render(<VoiceMicButton voiceEnabled={true} onTranscript={onTranscript} />)

    // Start recording
    await user.click(screen.getByLabelText('Start voice input'))
    await waitFor(() => screen.getByLabelText('Stop recording'))

    // Stop recording
    await user.click(screen.getByLabelText('Stop recording'))

    await waitFor(() => {
      expect(captured).toBe('hello world')
    })
  })

  it('shows transcribing state while postTranscribe is pending', async () => {
    mockPostTranscribe.mockImplementation(() => new Promise(() => {}))

    const user = userEvent.setup()
    render(<VoiceMicButton voiceEnabled={true} onTranscript={() => {}} />)

    await user.click(screen.getByLabelText('Start voice input'))
    await waitFor(() => screen.getByLabelText('Stop recording'))
    await user.click(screen.getByLabelText('Stop recording'))

    expect(await screen.findByLabelText('Transcribing…')).toBeTruthy()
    expect(screen.getByLabelText('Transcribing…').hasAttribute('disabled')).toBe(true)
  })

  it('returns to idle state after successful transcription', async () => {
    const user = userEvent.setup()
    render(<VoiceMicButton voiceEnabled={true} onTranscript={() => {}} />)

    await user.click(screen.getByLabelText('Start voice input'))
    await waitFor(() => screen.getByLabelText('Stop recording'))

    await user.click(screen.getByLabelText('Stop recording'))

    await waitFor(() => {
      expect(screen.getByLabelText('Start voice input')).toBeTruthy()
    })
  })

  it('does not call onTranscript when transcription returns empty text', async () => {
    mockPostTranscribe.mockImplementation(async () => ({ text: '' }))

    const user = userEvent.setup()
    let called = false
    const onTranscript = () => { called = true }

    render(<VoiceMicButton voiceEnabled={true} onTranscript={onTranscript} />)

    await user.click(screen.getByLabelText('Start voice input'))
    await waitFor(() => screen.getByLabelText('Stop recording'))
    await user.click(screen.getByLabelText('Stop recording'))

    await waitFor(() => screen.getByLabelText('Start voice input'))
    expect(called).toBe(false)
  })
})

describe('VoiceMicButton — error handling', () => {
  it('shows toast on transcription failure and returns to idle', async () => {
    mockPostTranscribe.mockImplementation(async () => {
      throw new Error('Server error')
    })

    const user = userEvent.setup()
    render(<VoiceMicButton voiceEnabled={true} onTranscript={() => {}} />)

    await user.click(screen.getByLabelText('Start voice input'))
    await waitFor(() => screen.getByLabelText('Stop recording'))
    await user.click(screen.getByLabelText('Stop recording'))

    await waitFor(() => screen.getByLabelText('Start voice input'))
    expect(mockPush).toHaveBeenCalled()
    const call = mockPush.mock.calls[0][0]
    expect(call.tone).toBe('error')
  })

  it('shows toast on mic permission denial and stays idle', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: mock(async () => {
          throw new Error('Permission denied')
        }),
      },
      configurable: true,
      writable: true,
    })

    const user = userEvent.setup()
    render(<VoiceMicButton voiceEnabled={true} onTranscript={() => {}} />)

    await user.click(screen.getByLabelText('Start voice input'))

    await waitFor(() => expect(mockPush).toHaveBeenCalled())
    const call = mockPush.mock.calls[0][0]
    expect(call.tone).toBe('error')

    // Should remain in idle state
    expect(screen.getByLabelText('Start voice input')).toBeTruthy()
  })
})
