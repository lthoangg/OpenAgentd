import { afterEach, describe, expect, it, mock } from 'bun:test'

import { useToastStore } from '@/stores/useToastStore'

function resetToastStore(): void {
  useToastStore.setState({ toasts: [] })
}

afterEach(resetToastStore)

describe('useToastStore', () => {
  it('clears an existing auto-dismiss timer when a toast is dismissed early', () => {
    const originalClearTimeout = window.clearTimeout
    const clearTimeout = mock((...args: unknown[]) => originalClearTimeout(args[0] as number | undefined))
    window.clearTimeout = clearTimeout as typeof window.clearTimeout

    try {
      useToastStore.getState().push({ tone: 'info', title: 'Saved' })
      const [toast] = useToastStore.getState().toasts

      useToastStore.getState().dismiss(toast.id)

      expect(clearTimeout).toHaveBeenCalledTimes(1)
      expect(useToastStore.getState().toasts).toEqual([])
    } finally {
      window.clearTimeout = originalClearTimeout
    }
  })
})
