/**
 * VoiceMicButton — microphone button for voice input.
 *
 * States:
 * - disabled  : voice not enabled or speech recognition unavailable
 * - idle      : click to request speech recognition permission and start listening
 * - listening : click to stop listening
 *
 * On success the transcript is delivered via `onTranscript`. Errors show as
 * toasts (useToastStore) and leave any existing input text unchanged.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, MicOff, AudioWaveform } from 'lucide-react'
import {
  isClientSpeechRecognitionSupported,
  startClientSpeechRecognition,
  type ClientSpeechSession,
} from '@/lib/speech-recognition'
import { useToastStore } from '@/stores/useToastStore'

export type VoiceState = 'idle' | 'listening'

interface VoiceMicButtonProps {
  /** Whether voice input is enabled. */
  voiceEnabled: boolean
  /** Called with the transcript text on success (only when text is non-empty). */
  onTranscript: (text: string) => void
  /** Whether the rest of the input bar is disabled. */
  disabled?: boolean
  /** Optional reason to show when voice input is unavailable. */
  unavailableReason?: string | null
}

const DISABLED_TOOLTIP = 'Voice input is disabled.'

const UNAVAILABLE_TOOLTIP =
  'Speech recognition is unavailable in this browser or WebView.'

export function VoiceMicButton({
  voiceEnabled,
  onTranscript,
  disabled = false,
  unavailableReason = null,
}: VoiceMicButtonProps) {
  // Treat unsupported speech recognition as "not enabled" for interaction;
  // only the tooltip changes so the user knows why.
  const supportReason = isClientSpeechRecognitionSupported() ? null : UNAVAILABLE_TOOLTIP
  const effectiveUnavailableReason = unavailableReason ?? supportReason
  const effectiveEnabled = voiceEnabled && !effectiveUnavailableReason
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const speechSessionRef = useRef<ClientSpeechSession | null>(null)
  const mountedRef = useRef(true)
  const pushToast = useToastStore((s) => s.push)

  // Track mount state so async callbacks don't update state after unmount.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      speechSessionRef.current?.stop()
      speechSessionRef.current = null
    }
  }, [])

  const startListening = useCallback(() => {
    startClientSpeechRecognition({
      onFinal: onTranscript,
      onError: (message) => {
        if (!mountedRef.current) return
        pushToast({ tone: 'error', title: 'Voice input error', description: message })
      },
      onEnd: () => {
        speechSessionRef.current = null
        if (mountedRef.current) setVoiceState('idle')
      },
    })
      .then((session) => {
        if (!mountedRef.current) {
          session.stop()
          return
        }
        speechSessionRef.current = session
        setVoiceState('listening')
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        const msg = err instanceof Error ? err.message : 'Speech recognition failed.'
        pushToast({ tone: 'error', title: 'Voice input error', description: msg })
        setVoiceState('idle')
      })
  }, [onTranscript, pushToast])

  const stopListening = useCallback(() => {
    speechSessionRef.current?.stop()
    speechSessionRef.current = null
  }, [])

  const handleClick = useCallback(() => {
    if (voiceState === 'idle') {
      startListening()
    } else if (voiceState === 'listening') {
      stopListening()
    }
  }, [voiceState, startListening, stopListening])

  // ── Render ────────────────────────────────────────────────────────────────

  const isEffectivelyDisabled = !effectiveEnabled || disabled

  let icon: React.ReactNode
  let label: string
  let title: string

  if (!effectiveEnabled) {
    icon = <MicOff size={14} />
    if (effectiveUnavailableReason) {
      label = 'Voice input unavailable'
      title = effectiveUnavailableReason
    } else {
      label = 'Voice input disabled'
      title = DISABLED_TOOLTIP
    }
  } else if (voiceState === 'listening') {
    icon = <AudioWaveform size={14} />
    label = 'Stop voice input'
    title = 'Click to stop listening'
  } else {
    icon = <Mic size={14} />
    label = 'Start voice input'
    title = 'Click to start voice input'
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isEffectivelyDisabled}
      aria-label={label}
      title={title}
      data-recording={voiceState === 'listening' ? 'true' : undefined}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        voiceState === 'listening'
          ? 'border-(--color-error) bg-(--color-error)/15 text-(--color-error) hover:bg-(--color-error)/25'
          : 'border-(--color-border) bg-(--color-surface) text-(--color-text-2) hover:bg-(--bg-key) hover:text-(--color-text)'
      }`}
    >
      {icon}
    </button>
  )
}
