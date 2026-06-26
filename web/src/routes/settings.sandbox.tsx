/**
 * /settings/sandbox — user-editable deny-list of glob patterns the agent
 * cannot access (system-level files like ``.env``, ``db/``, etc).
 */
import { useMemo, useState } from 'react'
import { AlertCircle, ChevronDown, Plus, Save, Trash2 } from 'lucide-react'

import {
  useSandboxSettingsQuery,
  useUpdateSandboxSettingsMutation,
} from '@/queries'
import { useToastStore } from '@/stores/useToastStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export function SandboxSettingsPage() {
  const { data, isLoading, error } = useSandboxSettingsQuery()
  const updateMut = useUpdateSandboxSettingsMutation()
  const push = useToastStore((s) => s.push)

  // Local working copy of the deny-list. Rebases onto each fresh server
  // snapshot via the snapshot identity (no effect needed).
  const [draft, setDraft] = useState<{
    source: readonly string[]
    patterns: string[]
  }>({ source: [], patterns: [] })

  const serverPatterns = data?.denied_patterns
  if (serverPatterns && serverPatterns !== draft.source) {
    setDraft({ source: serverPatterns, patterns: serverPatterns })
  }
  const patterns = draft.patterns
  const setPatterns = (next: string[] | ((prev: string[]) => string[])) =>
    setDraft((d) => ({
      source: d.source,
      patterns: typeof next === 'function' ? next(d.patterns) : next,
    }))

  const dirty = useMemo(() => {
    const a = draft.source
    if (a.length !== patterns.length) return true
    return a.some((p, i) => p !== patterns[i])
  }, [draft.source, patterns])

  const updateAt = (idx: number, value: string) =>
    setPatterns((prev) => prev.map((p, i) => (i === idx ? value : p)))

  const removeAt = (idx: number) =>
    setPatterns((prev) => prev.filter((_, i) => i !== idx))

  const addRow = () => setPatterns((prev) => [...prev, ''])

  const handleSave = async () => {
    const cleaned = patterns.map((p) => p.trim()).filter(Boolean)
    try {
      await updateMut.mutateAsync({ denied_patterns: cleaned })
      setPatterns(cleaned)
      push({
        tone: 'success',
        title: 'Sandbox saved',
        description: `${cleaned.length} pattern${cleaned.length === 1 ? '' : 's'} active.`,
      })
    } catch (err) {
      push({
        tone: 'error',
        title: 'Save failed',
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <>
      <header className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--bg-page) px-4 select-none">
        <h1 className="flex-1 truncate text-xs font-semibold text-(--color-text)">Sandbox</h1>
        {dirty && (
          <span className="text-xs text-(--color-text-subtle)" aria-live="polite">
            Unsaved
          </span>
        )}
        <Button
          size="sm"
          className="min-h-11 md:min-h-0"
          onClick={handleSave}
          disabled={!dirty || updateMut.isPending}
        >
          <Save size={12} aria-hidden="true" />
          {updateMut.isPending ? 'Saving…' : 'Save'}
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-(--bg-page)">
        <div className="mx-auto max-w-3xl space-y-4 p-5">
          <p className="text-xs leading-relaxed text-(--color-text-muted)">
            Glob patterns matched against the resolved absolute path. Use{' '}
            <code className="rounded bg-(--bg-key) px-1 py-0.5 font-mono text-xs">**</code>{' '}
            for any depth and{' '}
            <code className="rounded bg-(--bg-key) px-1 py-0.5 font-mono text-xs">*</code>{' '}
            for one path segment. The agent&rsquo;s workspace and shared memory
            are always reachable, even when a pattern would otherwise match.{' '}
            <SandboxHelpPopover />
          </p>

          {isLoading && (
            <p className="text-xs font-mono text-(--color-text-muted)">Loading…</p>
          )}

          {error && (
            <div
              className="flex items-start gap-2 rounded-md bg-(--color-error-subtle) p-3 text-xs text-(--color-error)"
              role="alert"
            >
              <AlertCircle size={13} aria-hidden="true" className="mt-0.5" />
              <span>{error instanceof Error ? error.message : String(error)}</span>
            </div>
          )}

          {!isLoading && !error && (
            <section className="space-y-3 rounded-md border border-(--color-border) bg-(--bg-card) p-4 shadow-sm">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-(--color-text-muted) border-b border-(--color-border)/60 pb-1.5 mb-3">
                Denied Patterns
              </h2>

              {patterns.length === 0 ? (
                <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-(--color-border) p-8 text-center">
                  <p className="text-xs font-semibold text-(--color-text)">No patterns</p>
                  <p className="max-w-sm text-[11px] leading-relaxed text-(--color-text-muted)">
                    Agents have unrestricted filesystem access (apart from the
                    built-in DB / state / cache denial). Add a pattern below to
                    block files like <code className="font-mono text-[10px]">.env</code> or
                    folders like <code className="font-mono text-[10px]">secrets/</code>.
                  </p>
                  <Button size="sm" className="min-h-11 md:min-h-0" onClick={addRow}>
                    <Plus size={12} aria-hidden="true" />
                    Add pattern
                  </Button>
                </div>
              ) : (
                <>
                  <ul className="space-y-1.5">
                    {patterns.map((pattern, idx) => (
                      <li key={idx} className="flex items-center gap-2">
                        <Input
                          value={pattern}
                          onChange={(e) => updateAt(idx, e.target.value)}
                          placeholder="**/.env"
                          aria-label={`Pattern ${idx + 1}`}
                          className="h-8.5 font-mono text-xs"
                        />
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                className="h-11 w-11 md:h-7 md:w-7"
                                onClick={() => removeAt(idx)}
                                aria-label={`Remove pattern ${idx + 1}`}
                              >
                                <Trash2 size={12} />
                              </Button>
                            }
                          />
                          <TooltipContent>Remove</TooltipContent>
                        </Tooltip>
                      </li>
                    ))}
                  </ul>

                  <Button size="sm" variant="outline" className="min-h-11 md:min-h-0" onClick={addRow}>
                    <Plus size={12} aria-hidden="true" />
                    Add pattern
                  </Button>
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </>
  )
}

// ─── Help popover ──────────────────────────────────────────────────────────

interface PatternExample {
  pattern: string
  description: string
}

const EXAMPLES: readonly PatternExample[] = [
  { pattern: '**/.env', description: 'Any file named .env, at any depth' },
  { pattern: '**/.env.*', description: 'Variants like .env.local, .env.prod' },
  { pattern: 'secrets/**', description: 'Everything under a secrets/ folder' },
  { pattern: '**/*.pem', description: 'PEM keys anywhere in the tree' },
  { pattern: '**/id_rsa*', description: 'SSH private keys (and .pub if you wish)' },
  { pattern: 'db/**', description: 'Local database files in db/' },
]

function SandboxHelpPopover() {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex min-h-11 items-center gap-0.5 rounded text-(--color-text) underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 md:min-h-0"
          >
            See examples
            <ChevronDown
              size={11}
              aria-hidden="true"
              className={cn(
                'transition-transform duration-150',
                open && 'rotate-180',
              )}
            />
          </button>
        }
      />
      <PopoverContent className="w-[min(20rem,calc(100vw-1rem))] gap-3 p-3" align="start">
        <ul className="flex flex-col gap-1.5">
          {EXAMPLES.map((ex) => (
            <li key={ex.pattern} className="flex flex-col gap-0.5">
              <code className="self-start rounded bg-(--bg-key) px-1.5 py-0.5 font-mono text-[10px] text-(--color-text)">
                {ex.pattern}
              </code>
              <span className="text-[10px] leading-snug text-(--color-text-muted)">
                {ex.description}
              </span>
            </li>
          ))}
        </ul>

        <p className="border-t border-(--color-border) pt-2 text-[10px] leading-snug text-(--color-text-muted)">
          Built-in DB / state / cache paths are always denied; matching is
          logical-OR across patterns &mdash; one match blocks access.
        </p>
      </PopoverContent>
    </Popover>
  )
}
