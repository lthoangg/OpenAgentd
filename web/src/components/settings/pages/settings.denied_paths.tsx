/**
 * /settings/denied_paths — user-editable path denylist of glob patterns the agent
 * cannot access (system-level files like ``.env``, ``db/``, etc).
 */
import { useState } from 'react'
import { ChevronDown, Plus, Shield, Trash2 } from 'lucide-react'

import {
  useDeniedPathsSettingsQuery,
  useUpdateDeniedPathsSettingsMutation,
} from '@/queries'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsSection } from '@/components/settings/SettingsSection'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { EmptyState } from '@/components/ui/empty-state'
import { useSettingsDraft } from '@/components/settings/useSettingsDraft'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface DeniedPathsForm {
  denied_patterns: string[]
}

/** Trims and drops blank rows, so an empty row the user abandoned is ignored. */
function normalize(form: DeniedPathsForm): DeniedPathsForm {
  return { denied_patterns: form.denied_patterns.map((p) => p.trim()).filter(Boolean) }
}

export function DeniedPathsSettingsPage() {
  const { data, isLoading, error } = useDeniedPathsSettingsQuery()
  const updateMut = useUpdateDeniedPathsSettingsMutation()

  const draft = useSettingsDraft<DeniedPathsForm>({
    data: data ? { denied_patterns: [...data.denied_patterns] } : undefined,
    initial: { denied_patterns: [] },
    normalize,
    onSave: async (value) => {
      await updateMut.mutateAsync(value)
      return value
    },
    successTitle: 'Denied paths saved',
  })

  const patterns = draft.value.denied_patterns
  const setPatterns = (next: (prev: string[]) => string[]) =>
    draft.set((prev) => ({ denied_patterns: next(prev.denied_patterns) }))

  const updateAt = (idx: number, value: string) =>
    setPatterns((prev) => prev.map((p, i) => (i === idx ? value : p)))
  const removeAt = (idx: number) => setPatterns((prev) => prev.filter((_, i) => i !== idx))
  const addRow = () => setPatterns((prev) => [...prev, ''])

  return (
    <SettingsPage
      title="Denied Paths"
      icon={Shield}
      draft={draft}
      loading={isLoading}
      error={error}
      intro={
        <>
          Glob patterns matched against the resolved absolute path. Use{' '}
          <code className="rounded-sm bg-(--bg-key) px-1 py-0.5 font-mono">**</code>{' '}
          for any depth and{' '}
          <code className="rounded-sm bg-(--bg-key) px-1 py-0.5 font-mono">*</code>{' '}
          for one path segment. The agent&rsquo;s workspace and shared memory
          are always reachable, even when a pattern would otherwise match.{' '}
          <DeniedPathsHelpPopover />
        </>
      }
    >
      <SettingsSection title="Denied patterns">
        {patterns.length === 0 ? (
          <EmptyState
            fill={false}
            icon={Shield}
            title="No patterns"
            body="Agents have unrestricted filesystem access, apart from the built-in DB, state and cache denial."
            tips={['**/.env blocks that file at any depth', 'secrets/** blocks a whole folder']}
            action={
              <Button size="sm" className="min-h-11 md:min-h-0" onClick={addRow}>
                <Plus size={12} aria-hidden="true" />
                Add pattern
              </Button>
            }
          />
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
                    className="min-h-11 font-mono text-xs md:min-h-9"
                  />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="h-9 w-9 md:h-7 md:w-7"
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

            <Button size="sm" variant="default" className="mt-2 min-h-11 md:min-h-0" onClick={addRow}>
              <Plus size={12} aria-hidden="true" />
              Add pattern
            </Button>
          </>
        )}
      </SettingsSection>
    </SettingsPage>
  )
}

export const SandboxSettingsPage = DeniedPathsSettingsPage

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

function DeniedPathsHelpPopover() {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex min-h-11 items-center gap-0.5 rounded-xs text-(--color-text) underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 md:min-h-0"
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
              <code className="self-start rounded-sm bg-(--bg-key) px-1.5 py-0.5 font-mono text-[10px] text-(--color-text)">
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
          logical-OR across patterns: one match blocks access.
        </p>
      </PopoverContent>
    </Popover>
  )
}
