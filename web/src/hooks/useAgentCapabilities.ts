import { useEffect, useState } from 'react'
import { listSessionAgents } from '@/api/client'
import type { AgentCapabilities } from '@/api/types'

const DEFAULT_CAPABILITIES: AgentCapabilities = {
  input: {
    vision: false,
    document_text: false,
    audio: false,
    video: false,
  },
  output: {
    text: true,
    image: false,
    audio: false,
  },
}

export function useAgentCapabilities(): AgentCapabilities {
  const [capabilities, setCapabilities] = useState<AgentCapabilities>(DEFAULT_CAPABILITIES)

  useEffect(() => {
    let mounted = true

    const fetchCapabilities = async () => {
      try {
        const data = await listSessionAgents('')
        // The session uses the first (and currently only) configured agent.
        const agent = data.agents[0]
        if (mounted) {
          setCapabilities(agent?.capabilities ?? DEFAULT_CAPABILITIES)
        }
      } catch (err) {
        console.warn('Failed to fetch agent capabilities:', err)
        if (mounted) {
          setCapabilities(DEFAULT_CAPABILITIES)
        }
      }
    }

    fetchCapabilities()

    return () => {
      mounted = false
    }
  }, [])

  return capabilities
}
