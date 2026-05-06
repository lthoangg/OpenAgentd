/**
 * VoiceMicButton — microphone button for voice input.
 *
 * States:
 * - disabled     : voice not configured; button visible but disabled with tooltip
 * - idle         : click to request mic permission and start recording
 * - recording    : click to stop recording and start transcription
 * - transcribing : upload in progress; button disabled/loading
 *
 * On success the transcript is delivered via `onTranscript`. Errors show as
 * toasts (useToastStore) and leave any existing input text unchanged.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Mic, MicOff, AudioWaveform } from 'lucide-react'
import { postTranscribe } from '@/api/client'
import { useToastStore } from '@/stores/useToastStore'

export type VoiceState = 'idle' | 'recording' | 'transcribing'

interface VoiceMicButtonProps {
  /** Whether voice input is enabled (from /api/speech/config). */
  voiceEnabled: boolean
  /** Called with the transcript text on success (only when text is non-empty). */
  onTranscript: (text: string) => void
  /** Whether the rest of the input bar is disabled. */
  disabled?: boolean
}

const DISABLED_TOOLTIP =
  'Voice mode is disabled. Enable it in settings to use voice input.'

export function VoiceMicButton({
  voiceEnabled,
  onTranscript,
  disabled = false,
}: VoiceMicButtonProps) {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const mountedRef = useRef(true)
  const pushToast = useToastStore((s) => s.push)

  // Track mount state so async callbacks don't update state after unmount.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      // Stop any in-progress recording on unmount to release the mic.
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
      mediaRecorderRef.current = null
    }
  }, [])

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      // onstop is synchronous — kick off the async transcription from it
      // rather than assigning an async function directly to the handler.
      recorder.onstop = () => {
        // Release mic tracks immediately when recording stops.
        stream.getTracks().forEach((t) => t.stop())

        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        })
        chunksRef.current = []

        if (!mountedRef.current) return

        setVoiceState('transcribing')

        postTranscribe(blob)
          .then((result) => {
            if (!mountedRef.current) return
            if (result.text) onTranscript(result.text)
          })
          .catch((err: unknown) => {
            if (!mountedRef.current) return
            const msg = err instanceof Error ? err.message : 'Transcription failed.'
            pushToast({ tone: 'error', title: 'Voice input error', description: msg })
          })
          .finally(() => {
            if (mountedRef.current) setVoiceState('idle')
          })
      }

      recorder.start()
      mediaRecorderRef.current = recorder
      setVoiceState('recording')
    } catch (err) {
      // Permission denied or device unavailable — preserve existing input.
      if (!mountedRef.current) return
      const msg = err instanceof Error ? err.message : 'Microphone access denied.'
      pushToast({ tone: 'error', title: 'Microphone error', description: msg })
      setVoiceState('idle')
    }
  }, [onTranscript, pushToast])

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop()
    mediaRecorderRef.current = null
  }, [])

  const handleClick = useCallback(() => {
    if (voiceState === 'idle') {
      void startRecording()
    } else if (voiceState === 'recording') {
      stopRecording()
    }
    // transcribing: button is disabled — click unreachable
  }, [voiceState, startRecording, stopRecording])

  // ── Render ────────────────────────────────────────────────────────────────

  const isEffectivelyDisabled = !voiceEnabled || disabled || voiceState === 'transcribing'

  let icon: React.ReactNode
  let label: string
  let title: string

  if (!voiceEnabled) {
    icon = <MicOff size={14} />
    label = 'Voice input disabled'
    title = DISABLED_TOOLTIP
  } else if (voiceState === 'transcribing') {
    icon = <Loader2 size={14} className="animate-spin" />
    label = 'Transcribing…'
    title = 'Transcribing audio…'
  } else if (voiceState === 'recording') {
    icon = <AudioWaveform size={14} />
    label = 'Stop recording'
    title = 'Click to stop recording'
  } else {
    icon = <Mic size={14} />
    label = 'Start voice input'
    title = 'Click to start recording'
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isEffectivelyDisabled}
      aria-label={label}
      title={title}
      data-recording={voiceState === 'recording' ? 'true' : undefined}
      className={`flex h-8 w-8 shrink-0 self-end items-center justify-center rounded-full transition-colors disabled:opacity-25 ${
        voiceState === 'recording'
          ? 'bg-(--color-error)/15 text-(--color-error) hover:bg-(--color-error)/25'
          : 'text-(--color-text-muted) hover:bg-(--color-accent-subtle) hover:text-(--color-text)'
      }`}
    >
      {icon}
    </button>
  )
}
