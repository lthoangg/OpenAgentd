/**
 * Settings → Blocked files: the patterns for files and folders agents cannot
 * read or change (`.env`, a folder of keys, …). Each rule shows what it blocks
 * as a sentence, with its pattern under it; a folder is added by picking it.
 */
import { useCallback, useEffect, useState } from 'react'
import { Folder, FolderPlus, Plus, Shield, Trash2 } from 'lucide-react'

import {
  useDeniedPathsSettingsQuery,
  useUpdateDeniedPathsSettingsMutation,
} from '@/queries'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { PanelSection } from '@/components/ui/panel-section'
import { PanelRow } from '@/components/ui/panel-row'
import { Skeleton } from '@/components/ui/skeleton'
import { TEXT } from '@/components/ui/panel-tokens'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { EmptyState } from '@/components/ui/empty-state'
import { useSettingsDraft } from '@/components/settings/useSettingsDraft'
import { describePattern, folderPattern } from '@/components/settings/blocked-patterns'
import { loadWorkspaceBrowser, shouldUseServerWorkspaceBrowser, type WorkspaceBrowserState } from '@/components/Sidebar.browser'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePlatform } from '@/hooks/use-platform'
import { isMobileApp } from '@/lib/mobile-app'
import { errorMessage } from '@/utils/errors'

interface DeniedPathsForm {
  denied_patterns: string[]
}

/** Trims and drops blank rows, so an empty row the user abandoned is ignored. */
function normalize(form: DeniedPathsForm): DeniedPathsForm {
  return { denied_patterns: form.denied_patterns.map((p) => p.trim()).filter(Boolean) }
}

/** Patterns worth one press: each is offered until it is in the list. */
const EXAMPLES: readonly string[] = ['**/.env', '**/secrets/**', '**/*.pem', '**/id_rsa*']

/** The OS folder dialog, for a desktop app whose agents run on this computer. */
async function pickFolderOnThisComputer(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({ directory: true, multiple: false, title: 'Block a folder' })
  return typeof selected === 'string' ? selected : null
}

export function DeniedPathsSettingsPage() {
  const { data, isLoading, error } = useDeniedPathsSettingsQuery()
  const updateMut = useUpdateDeniedPathsSettingsMutation()
  const platform = usePlatform()
  const [browsing, setBrowsing] = useState(false)

  const draft = useSettingsDraft<DeniedPathsForm>({
    data: data ? { denied_patterns: [...data.denied_patterns] } : undefined,
    initial: { denied_patterns: [] },
    normalize,
    onSave: async (value) => {
      await updateMut.mutateAsync(value)
      return value
    },
    successTitle: 'Blocked files saved',
  })

  const patterns = draft.value.denied_patterns
  const setPatterns = (next: (prev: string[]) => string[]) =>
    draft.set((prev) => ({ denied_patterns: next(prev.denied_patterns) }))

  const updateAt = (idx: number, value: string) =>
    setPatterns((prev) => prev.map((p, i) => (i === idx ? value : p)))
  const removeAt = (idx: number) => setPatterns((prev) => prev.filter((_, i) => i !== idx))
  const add = (pattern: string) => setPatterns((prev) => (pattern && prev.includes(pattern) ? prev : [...prev, pattern]))

  // The folder is one on the computer the agents run on: the OS dialog when
  // that is this computer, the server's own folder list otherwise.
  const blockFolder = async () => {
    const mobileApp = isMobileApp(platform)
    if (await shouldUseServerWorkspaceBrowser(platform.isTauri, mobileApp)) {
      setBrowsing(true)
      return
    }
    const picked = await pickFolderOnThisComputer()
    if (picked) add(folderPattern(picked))
  }

  const blockFolderButton = (
    <Button size="sm" variant="default" className="min-h-9 md:min-h-0" onClick={() => { void blockFolder() }}>
      <FolderPlus size={12} aria-hidden="true" />
      Block a folder…
    </Button>
  )
  const offered = EXAMPLES.filter((example) => !patterns.includes(example))

  return (
    <SettingsPage
      title="Blocked files"
      draft={draft}
      loading={isLoading}
      error={error}
      description="Files and folders agents cannot read or change. OpenAgentd's own database, state and cache are always blocked."
    >
      <PanelSection title="Blocked" actions={patterns.length > 0 ? blockFolderButton : null}>
        {patterns.length === 0 ? (
          <EmptyState
            fill={false}
            className="py-4"
            icon={Shield}
            title="Nothing is blocked"
            body="Agents can read and change the files in the workspace they work in."
            action={blockFolderButton}
          />
        ) : (
          <ul className="space-y-4">
            {patterns.map((pattern, idx) => {
              const id = `blocked-pattern-${idx}`
              return (
                <li key={idx} className="flex items-end gap-2">
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <label htmlFor={id} className={TEXT.label}>{describePattern(pattern)}</label>
                    <Input
                      id={id}
                      value={pattern}
                      onChange={(e) => updateAt(idx, e.target.value)}
                      placeholder="**/.env"
                      spellCheck={false}
                      className="h-9 font-mono text-xs"
                    />
                  </div>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="h-9 w-9 text-(--color-text-muted) hover:text-(--color-error) md:mb-1 md:h-7 md:w-7"
                          onClick={() => removeAt(idx)}
                          aria-label={pattern.trim() ? `Remove “${pattern.trim()}”` : 'Remove the new pattern'}
                        >
                          <Trash2 size={12} />
                        </Button>
                      }
                    />
                    <TooltipContent>Remove</TooltipContent>
                  </Tooltip>
                </li>
              )
            })}
          </ul>
        )}
      </PanelSection>

      <PanelSection
        title="Add a pattern"
        description={
          <>
            A pattern is matched against a file&apos;s full path.{' '}
            <code className="rounded-xs bg-(--bg-key) px-1 font-mono">*</code> stands for any text, folders included.
          </>
        }
        flush
      >
        {offered.map((example) => (
          <PanelRow key={example} inline label={describePattern(example)} description={<code className="font-mono">{example}</code>}>
            <Button size="sm" variant="default" className="min-h-9 md:min-h-0" onClick={() => add(example)} aria-label={`Add “${example}”`}>
              <Plus size={12} aria-hidden="true" />
              Add
            </Button>
          </PanelRow>
        ))}
        <PanelRow inline label="A pattern of your own">
          <Button size="sm" variant="default" className="min-h-9 md:min-h-0" onClick={() => add('')}>
            Write your own
          </Button>
        </PanelRow>
      </PanelSection>

      <BlockFolderDialog
        open={browsing}
        onClose={() => setBrowsing(false)}
        onPick={(path) => {
          add(folderPattern(path))
          setBrowsing(false)
        }}
      />
    </SettingsPage>
  )
}

// ─── Folder list of the computer the agents run on ─────────────────────────

function BlockFolderDialog({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (path: string) => void }) {
  const [browser, setBrowser] = useState<WorkspaceBrowserState | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const browse = useCallback(async (path: string | null) => {
    setLoading(true)
    setError(null)
    try {
      setBrowser(await loadWorkspaceBrowser(path))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  // Each open starts at the server's starting folder.
  useEffect(() => {
    if (!open) return
    setBrowser(null)
    void browse(null)
  }, [open, browse])

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Block a folder</DialogTitle>
          <DialogDescription>Agents cannot read or change anything in the folder you choose.</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-2">
          <div className="min-w-0 rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2">
            <p className="min-w-0 font-mono text-xs text-(--color-text-muted) [overflow-wrap:anywhere]">
              {browser?.path ?? 'Loading folders…'}
            </p>
          </div>
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-sm border border-(--color-border) bg-(--bg-card) p-1">
            {browser?.parent && (
              <button
                type="button"
                aria-label="Up one folder"
                className="w-full rounded-xs px-2 py-1.5 text-left text-sm hover:bg-(--bg-key)"
                onClick={() => void browse(browser.parent)}
              >
                ..
              </button>
            )}
            {loading && !browser && (
              <div role="status" aria-label="Loading folders" className="space-y-2 px-2 py-3">
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            )}
            {!loading && browser && browser.directories.length === 0 && (
              <EmptyState compact icon={Folder} title="No folders here" className="px-2 py-3" />
            )}
            {browser?.directories.map((dir) => (
              <button
                type="button"
                key={dir.path}
                className="flex w-full min-w-0 items-center gap-2 rounded-xs px-2 py-1.5 text-left text-sm hover:bg-(--bg-key)"
                onClick={() => void browse(dir.path)}
              >
                <Folder size={14} className="shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate">{dir.name}</span>
              </button>
            ))}
          </div>
          {error && <p role="alert" className="text-xs text-(--color-error)">{error}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" disabled={!browser || loading} onClick={() => { if (browser) onPick(browser.path) }}>
            Block this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
