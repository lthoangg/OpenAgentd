/**
 * Settings → Browser: which sites the agent may use in the Preview tab
 * (ask for each new one or allow all, a list of allowed sites and a list of
 * blocked ones), and clearing the Preview tab's own browser profile in the
 * desktop app. The rules are kept by the server; each change saves at once.
 */
import { useId, useState, type FormEvent } from 'react'
import { Globe, Trash2 } from 'lucide-react'

import type { BrowserSites } from '@/api/client'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { COMPACT_ROW } from '@/components/ui/panel-tokens'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { ruleName } from '@/components/Preview/site-access'
import { browserViewsAvailable, clearBrowserProfile } from '@/lib/browser-view'
import { useBrowserSitesQuery, useChangeBrowserSitesMutation } from '@/queries'
import { useToastStore } from '@/stores/useToastStore'
import { errorMessage } from '@/utils/errors'

const DEFAULT_OPTIONS = [
  { value: 'ask', label: 'Ask for each new site' },
  { value: 'allow', label: 'Allow all sites' },
] as const

const EMPTY: BrowserSites = { default: 'ask', allowed: [], blocked: [] }

function SiteList({ title, description, empty, sites, addLabel, busy, onAdd, onRemove }: {
  title: string
  description: string
  empty: string
  sites: string[]
  addLabel: string
  busy: boolean
  /** Resolves the reason when the site was not added. */
  onAdd: (site: string) => Promise<string | null>
  onRemove: (site: string) => void
}) {
  const inputId = useId()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const site = draft.trim()
    if (!site) return
    const failed = await onAdd(site)
    setError(failed)
    if (!failed) setDraft('')
  }
  return (
    <PanelSection title={title} description={description} flush>
      {sites.length === 0 ? (
        <EmptyState compact icon={Globe} title={empty} className="px-3 py-3" />
      ) : (
        <ul>
          {sites.map((site) => (
            <li key={site} className={COMPACT_ROW}>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{site}</span>
              <Button size="icon-sm" variant="ghost" className="h-9 w-9 text-(--color-text-muted) hover:text-(--color-error) md:h-7 md:w-7" disabled={busy} onClick={() => onRemove(site)} aria-label={`Remove ${site}`}>
                <Trash2 size={12} aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(event) => void submit(event)} className="px-3 py-3 md:px-4">
        <Field label={addLabel} htmlFor={inputId} error={error} hint="A site such as example.com, or *.example.com for its subdomains.">
          <div className="flex items-center gap-2">
            <Input
              id={inputId}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value)
                setError(null)
              }}
              placeholder="example.com"
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              className="h-9 min-w-0 flex-1 font-mono text-xs"
            />
            <Button type="submit" size="sm" variant="default" className="min-h-9 md:min-h-0" disabled={busy || !draft.trim()}>
              Add
            </Button>
          </div>
        </Field>
      </form>
    </PanelSection>
  )
}

export function BrowserSettingsPage() {
  const { data, isLoading, error } = useBrowserSitesQuery()
  const update = useChangeBrowserSitesMutation()
  const push = useToastStore((s) => s.push)
  const [clearing, setClearing] = useState(false)
  const rules = data ?? EMPTY

  /** Applies `change` to the rules as they are now; resolves the reason when the server refused it. */
  const save = async (change: (rules: BrowserSites) => BrowserSites, done: string | null): Promise<string | null> => {
    try {
      await update.mutateAsync(change)
      if (done) push({ tone: 'success', title: done })
      return null
    } catch (err) {
      return errorMessage(err)
    }
  }
  const saveOrToast = async (change: (rules: BrowserSites) => BrowserSites, done: string | null) => {
    const failed = await save(change, done)
    if (failed) push({ tone: 'error', title: "Couldn't save the sites", description: failed })
  }
  const add = (list: 'allowed' | 'blocked') => (site: string) => {
    const other = list === 'allowed' ? 'blocked' : 'allowed'
    // The server names the site (a pasted address becomes its host); the other list gives it up.
    return save((now) => ({ ...now, [list]: [...now[list], site], [other]: now[other].filter((rule) => rule !== ruleName(site)) }), list === 'allowed' ? 'Site allowed' : 'Site blocked')
  }
  const remove = (list: 'allowed' | 'blocked') => (site: string) =>
    void saveOrToast((now) => ({ ...now, [list]: now[list].filter((rule) => rule !== site) }), 'Site removed')

  return (
    <SettingsPage
      title="Browser"
      loading={isLoading}
      error={error}
      description="Public sites open in the desktop app's Preview tab, in a browser profile of its own: separate from your other browsers, and signed in only where you signed in there."
    >
      <PanelSection title="Agent access" flush>
        <PanelRow label="Sites the agent may use" description="You can always browse any site yourself.">
          <SegmentedControl
            label="Sites the agent may use"
            options={DEFAULT_OPTIONS}
            value={rules.default}
            disabled={update.isPending}
            onChange={(value) => void saveOrToast((now) => ({ ...now, default: value }), null)}
          />
        </PanelRow>
      </PanelSection>

      <SiteList
        title="Allowed sites"
        description="The agent uses these without asking, signed in as you are in the Preview tab."
        empty="No allowed sites"
        addLabel="Allow a site"
        sites={rules.allowed}
        busy={update.isPending}
        onAdd={add('allowed')}
        onRemove={remove('allowed')}
      />
      <SiteList
        title="Blocked sites"
        description="The agent never uses these, even when all sites are allowed."
        empty="No blocked sites"
        addLabel="Block a site"
        sites={rules.blocked}
        busy={update.isPending}
        onAdd={add('blocked')}
        onRemove={remove('blocked')}
      />

      {browserViewsAvailable() && (
        <PanelSection title="Browsing data" flush>
          <PanelRow label="Clear browsing data" description="Deletes the cookies and stored data of every site in the Preview tab. You are signed out of all of them.">
            <Button size="sm" variant="default" className="min-h-9 md:min-h-0" onClick={() => setClearing(true)}>
              Clear…
            </Button>
          </PanelRow>
        </PanelSection>
      )}
      <ConfirmDialog
        open={clearing}
        onOpenChange={setClearing}
        title="Clear browsing data?"
        description="Every site in the Preview tab is signed out, and what they stored is deleted. This can't be undone."
        confirmLabel="Clear"
        onConfirm={async () => {
          try {
            await clearBrowserProfile()
            push({ tone: 'success', title: 'Browsing data cleared' })
          } catch (err) {
            push({ tone: 'error', title: "Couldn't clear browsing data", description: errorMessage(err) })
          }
        }}
      />
    </SettingsPage>
  )
}
