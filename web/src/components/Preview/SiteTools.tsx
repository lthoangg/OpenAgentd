/**
 * A site tab's own toolbar controls: what the agent may do on the site the
 * page is on (the rules of Settings → Browser, for this one site), and a
 * menu for the site's cookies in the Preview tab's profile.
 */
import { useEffect, useId, useState } from 'react'
import { Bot, MoreHorizontal } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { Field } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { clearBrowserViewCookies, importBrowserCookies } from '@/lib/browser-view'
import { cn } from '@/lib/utils'
import { useBrowserSitesQuery, useChangeBrowserSitesMutation } from '@/queries'
import { queryKeys } from '@/queries/keys'
import { useToastStore } from '@/stores/useToastStore'
import { errorMessage } from '@/utils/errors'
import { DOCK_ACTION_BUTTON_CLASS } from '../WorkspacePanel/dock-tab-styles'
import { type SiteChoice, siteAccess, siteName, withSiteAccess } from './site-access'

const CHOICE_LABEL: Record<SiteChoice, string> = {
  allow: 'Agent allowed',
  ask: 'Agent asks first',
  block: 'Agent blocked',
}

function isChoice(value: string): value is SiteChoice {
  return value === 'allow' || value === 'ask' || value === 'block'
}

/**
 * What the agent may do on `host`'s site, and the picker that changes it.
 * `refreshKey` changes when the answer may have (the agent just used the
 * page, perhaps after the user answered its card).
 */
export function SiteAccessPicker({ host, refreshKey }: { host: string; refreshKey: unknown }) {
  const rules = useBrowserSitesQuery().data
  const update = useChangeBrowserSitesMutation()
  const queryClient = useQueryClient()
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.settings.browserSites() })
  }, [queryClient, refreshKey])
  if (!rules || !host) return null
  const site = siteName(host)
  const choice = siteAccess(rules, host)
  const change = (value: string) => {
    if (!isChoice(value) || value === choice) return
    update.mutate((now) => withSiteAccess(now, host, value), {
      onError: (err) => useToastStore.getState().push({ tone: 'error', title: `Couldn't change what the agent may do on ${site}`, description: errorMessage(err) }),
    })
  }
  return (
    <Dropdown
      aria-label={`Agent access to ${site}`}
      value={choice}
      onValueChange={change}
      align="end"
      dense
      disabled={update.isPending}
      className="h-7 shrink-0 gap-1 rounded-xs px-1.5 text-meta"
      trigger={null}
      // The icon always; the words once the panel has room for them.
      renderValue={() => (
        <span className="flex items-center gap-1">
          <Bot size={12} aria-hidden="true" className={cn(choice === 'block' && 'opacity-40')} />
          <span className="hidden @2xl:inline">{CHOICE_LABEL[choice]}</span>
        </span>
      )}
    >
      {[
        <DropdownItem key="allow" value="allow">Always allow the agent on {site}</DropdownItem>,
        // With every site allowed, a site in no list is allowed too: there is no asking.
        rules.default === 'ask' ? <DropdownItem key="ask" value="ask">Ask each time</DropdownItem> : null,
        <DropdownItem key="block" value="block">Block the agent on {site}</DropdownItem>,
      ].filter(Boolean)}
    </Dropdown>
  )
}

function ImportCookiesDialog({ viewId, site, open, onClose }: { viewId: string; site: string; open: boolean; onClose: () => void }) {
  const fieldId = useId()
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // What was pasted signs the user in: it is not kept once the dialog closes.
  useEffect(() => {
    if (open) return
    setText('')
    setError(null)
  }, [open])
  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      const report = await importBrowserCookies(viewId, text)
      const cookies = `${report.imported} ${report.imported === 1 ? 'cookie' : 'cookies'}`
      const left = report.other_sites > 0 ? `${report.other_sites} for other sites ${report.other_sites === 1 ? 'was' : 'were'} left out.` : undefined
      useToastStore.getState().push({ tone: 'success', title: `Imported ${cookies} for ${report.site}`, description: left })
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import cookies for {site}</DialogTitle>
          <DialogDescription>
            For a site that will not sign in here. In a browser where you are signed in to {site}, export its cookies (a cookie
            extension&apos;s JSON, or a cookies.txt file) and paste them. They are saved in the Preview tab&apos;s profile and not shown again.
          </DialogDescription>
        </DialogHeader>
        <Field label="Cookie export" htmlFor={fieldId} error={error} hint="Cookies sign in as you. Paste them only here, never into a chat.">
          <Textarea
            id={fieldId}
            value={text}
            onChange={(event) => {
              setText(event.target.value)
              setError(null)
            }}
            placeholder='[{"domain": ".example.com", "name": "…", "value": "…"}]'
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            className="h-40 font-mono text-xs"
          />
        </Field>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" disabled={busy || !text.trim()} onClick={() => void run()}>Import</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The site's cookies in the Preview tab's profile: bring them in, or delete them. */
export function SiteMenu({ viewId, host }: { viewId: string; host: string }) {
  const [importing, setImporting] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const site = siteName(host)
  return (
    <>
      <Dropdown
        aria-label="Site options"
        align="end"
        dense
        trigger={<MoreHorizontal size={14} aria-hidden="true" />}
        className={cn(DOCK_ACTION_BUTTON_CLASS, 'size-7 justify-center! rounded-xs border-0 bg-transparent p-0! [&>span]:justify-center [&>svg]:hidden')}
        panelClassName="w-56"
        disabled={!host}
      >
        <DropdownItem onSelect={() => setImporting(true)}>Import cookies…</DropdownItem>
        <DropdownItem onSelect={() => setSigningOut(true)}>Sign out of this site…</DropdownItem>
      </Dropdown>
      <ImportCookiesDialog viewId={viewId} site={site} open={importing} onClose={() => setImporting(false)} />
      <ConfirmDialog
        open={signingOut}
        onOpenChange={setSigningOut}
        title={`Sign out of ${site}?`}
        description="Its cookies are deleted from the Preview tab's profile, and the page loads again. Your other browsers are not affected."
        confirmLabel="Sign out"
        onConfirm={async () => {
          try {
            const count = await clearBrowserViewCookies(viewId)
            useToastStore.getState().push({ tone: 'success', title: count > 0 ? `Signed out of ${site}` : `${site} had no cookies` })
          } catch (err) {
            useToastStore.getState().push({ tone: 'error', title: `Couldn't sign out of ${site}`, description: errorMessage(err) })
          }
        }}
      />
    </>
  )
}
