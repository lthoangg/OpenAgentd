import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ToastStack } from '@/components/ToastStack'
import { useToastStore } from '@/stores/useToastStore'

mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => false, MOBILE_QUERY: '(max-width: 767px)' }))

let importResult: { site: string; imported: number; other_sites: number; unreadable: number } | Error = { site: 'shop.example', imported: 3, other_sites: 2, unreadable: 0 }
const imported = mock(async (..._args: unknown[]) => {
  if (importResult instanceof Error) throw importResult
  return importResult
})
const clearedSite = mock(async (..._args: unknown[]) => 4)
mock.module('@/lib/browser-view', () => ({ importBrowserCookies: imported, clearBrowserViewCookies: clearedSite }))

import { SiteMenu } from '@/components/Preview/SiteTools'

beforeEach(() => {
  importResult = { site: 'shop.example', imported: 3, other_sites: 2, unreadable: 0 }
  imported.mockClear()
  clearedSite.mockClear()
  useToastStore.setState({ toasts: [] })
})
afterEach(cleanup)

function renderMenu() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <SiteMenu viewId="view-1" host="www.shop.example" />
      <ToastStack />
    </QueryClientProvider>,
  )
}

async function choose(item: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Site options' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: item }))
}

const EXPORT = '[{"domain": ".shop.example", "name": "sid", "value": "s3cr3t"}]'

describe('SiteMenu', () => {
  it("imports a pasted cookie export into the view's profile and says what was kept", async () => {
    renderMenu()
    await choose('Import cookies…')
    expect(await screen.findByRole('heading', { name: 'Import cookies for shop.example' })).toBeTruthy()
    const importButton = screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement
    expect(importButton.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Cookie export'), { target: { value: EXPORT } })
    fireEvent.click(importButton)
    await waitFor(() => expect(imported).toHaveBeenCalledWith('view-1', EXPORT))
    expect(await screen.findByText('Imported 3 cookies for shop.example')).toBeTruthy()
    expect(screen.getByText('2 for other sites were left out.')).toBeTruthy()
    // The dialog closed, and nothing on screen repeats what was pasted.
    await waitFor(() => expect(screen.queryByLabelText('Cookie export')).toBeNull())
    expect(document.body.textContent).not.toContain('s3cr3t')
  })

  it('says why an export was not imported, and forgets it when the dialog closes', async () => {
    importResult = new Error('None of these cookies are for shop.example. Open the site they are from, then import them there.')
    renderMenu()
    await choose('Import cookies…')
    fireEvent.change(await screen.findByLabelText('Cookie export'), { target: { value: EXPORT } })
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(await screen.findByText(/None of these cookies are for shop.example/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByLabelText('Cookie export')).toBeNull())
    await choose('Import cookies…')
    expect(((await screen.findByLabelText('Cookie export')) as HTMLTextAreaElement).value).toBe('')
    expect(screen.queryByText(/None of these cookies/)).toBeNull()
  })

  it('signs out of the site only after asking', async () => {
    renderMenu()
    await choose('Sign out of this site…')
    expect(await screen.findByText('Sign out of shop.example?')).toBeTruthy()
    expect(clearedSite).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(clearedSite).toHaveBeenCalledWith('view-1'))
    expect(await screen.findByText('Signed out of shop.example')).toBeTruthy()
  })
})
