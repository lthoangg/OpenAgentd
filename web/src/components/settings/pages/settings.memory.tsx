/**
 * /settings/memory — Persistent Markdown memory viewer, editor, and linter.
 */
import { useState, useEffect, useRef } from 'react'
import {
  AlertCircle,
  Brain,
  CheckCircle2,
  FileText,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react'

import {
  useMemoryTreeQuery,
  useMemoryFileQuery,
  useSaveMemoryFileMutation,
  useDeleteMemoryFileMutation,
} from '@/queries'
import {
  lintMemory,
  ApiValidationError,
  type MemoryFindingItem,
} from '@/api/client'
import { useToastStore } from '@/stores/useToastStore'
import { useUnsavedSettings } from '@/hooks/useUnsavedSettings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ICON_SIZE, ICON_SIZE_INLINE, TEXT } from '@/components/settings/tokens'
import { cn } from '@/lib/utils'

export function MemorySettingsPage() {
  const push = useToastStore((s) => s.push)

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [draftContent, setDraftContent] = useState<string>('')
  const [newFileOpen, setNewFileOpen] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [conflictOpen, setConflictOpen] = useState(false)

  const [isLinting, setIsLinting] = useState(false)
  const [lintFindings, setLintFindings] = useState<MemoryFindingItem[] | null>(null)

  const {
    data: treeData,
    isLoading: treeLoading,
    refetch: refetchTree,
  } = useMemoryTreeQuery()

  const {
    data: fileData,
    isLoading: fileLoading,
    refetch: refetchFile,
  } = useMemoryFileQuery(selectedPath)

  const saveMut = useSaveMemoryFileMutation()
  const deleteMut = useDeleteMemoryFileMutation()

  // Automatically select first page if none selected
  useEffect(() => {
    if (!selectedPath && treeData?.pages && treeData.pages.length > 0) {
      setSelectedPath(treeData.pages[0].path)
    }
  }, [selectedPath, treeData])

  // Keep draft in sync with loaded file
  useEffect(() => {
    if (fileData) {
      setDraftContent(fileData.content)
    }
  }, [fileData])

  const isDirty = fileData ? draftContent !== fileData.content : draftContent.length > 0
  useUnsavedSettings(isDirty)

  const handleSave = async () => {
    if (!selectedPath) return
    try {
      await saveMut.mutateAsync({
        path: selectedPath,
        content: draftContent,
        ifMatch: fileData?.etag,
      })
      push({ tone: 'success', title: `Saved "${selectedPath}"` })
      refetchTree()
      refetchFile()
    } catch (err) {
      if (err instanceof ApiValidationError && err.status === 412) {
        setConflictOpen(true)
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        push({ tone: 'error', title: 'Save failed', description: msg })
      }
    }
  }

  const saveActionRef = useRef({ handleSave, isDirty, isSaving: saveMut.isPending, selectedPath })
  useEffect(() => {
    saveActionRef.current = { handleSave, isDirty, isSaving: saveMut.isPending, selectedPath }
  })

  // Cmd/Ctrl+S keyboard shortcut to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's')) return
      const current = saveActionRef.current
      if (!current.selectedPath || !current.isDirty || current.isSaving) return
      e.preventDefault()
      void current.handleSave()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const handleDelete = async () => {
    if (!selectedPath || !fileData) return
    try {
      await deleteMut.mutateAsync({
        path: selectedPath,
        ifMatch: fileData.etag,
      })
      push({ tone: 'success', title: `Deleted "${selectedPath}"` })
      setDeleteOpen(false)
      setSelectedPath(null)
      refetchTree()
    } catch (err) {
      if (err instanceof ApiValidationError && err.status === 412) {
        setConflictOpen(true)
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        push({ tone: 'error', title: 'Delete failed', description: msg })
      }
    }
  }

  const handleCreateNew = async () => {
    let filename = newFileName.trim()
    if (!filename) return
    if (!filename.endsWith('.md')) filename += '.md'
    try {
      await saveMut.mutateAsync({
        path: filename,
        content: `# ${filename.replace('.md', '')}\n\n`,
      })
      push({ tone: 'success', title: `Created "${filename}"` })
      setNewFileOpen(false)
      setNewFileName('')
      setSelectedPath(filename)
      refetchTree()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      push({ tone: 'error', title: 'Create failed', description: msg })
    }
  }

  const handleRunLint = async () => {
    setIsLinting(true)
    try {
      const report = await lintMemory()
      setLintFindings(report.findings)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      push({ tone: 'error', title: 'Lint check failed', description: msg })
    } finally {
      setIsLinting(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-(--bg-page) text-(--color-text)">
      {/* Sticky Header matching Settings standard */}
      <header className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--bg-page) px-3 sm:px-4 select-none">
        <Brain
          size={ICON_SIZE}
          className="shrink-0 text-(--color-text-muted)"
          aria-hidden="true"
        />
        <h1 className={cn('truncate', TEXT.title)}>Memory</h1>
        <div className="min-w-1 flex-1" />
        <Button
          variant="subtle"
          size="sm"
          onClick={handleRunLint}
          disabled={isLinting}
          className="flex items-center gap-1.5 text-xs"
        >
          <RefreshCw
            size={ICON_SIZE_INLINE}
            className={cn('shrink-0', isLinting && 'animate-spin')}
            aria-hidden="true"
          />
          <span>{isLinting ? 'Linting…' : 'Run Lint'}</span>
        </Button>
      </header>

      {/* Description bar */}
      <div className="border-b border-(--color-border) bg-(--bg-page) px-3 py-2.5 sm:px-4">
        <p className={TEXT.body}>
          Persistent human-editable Markdown knowledge base and standing directives across all workspaces.
        </p>
      </div>

      {/* Lint findings banner */}
      {lintFindings !== null && (
        <div
          className={cn(
            'mx-3 my-2.5 sm:mx-4 rounded-sm border p-3 text-xs',
            lintFindings.length === 0
              ? 'border-(--color-success)/30 bg-(--color-success-subtle) text-(--color-accent-green-text)'
              : 'border-(--color-warning)/30 bg-(--color-warning-subtle) text-(--color-accent-orange-text)',
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-medium">
              {lintFindings.length === 0 ? (
                <>
                  <CheckCircle2 size={14} className="shrink-0" aria-hidden="true" />
                  <span>All memory pages and wikilinks are valid.</span>
                </>
              ) : (
                <>
                  <AlertCircle size={14} className="shrink-0" aria-hidden="true" />
                  <span>{lintFindings.length} issue(s) found:</span>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => setLintFindings(null)}
              className="cursor-pointer text-xs underline hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
            >
              Dismiss
            </button>
          </div>
          {lintFindings.length > 0 && (
            <ul className="mt-2 space-y-1.5 font-normal">
              {lintFindings.map((f, i) => (
                <li key={i} className="flex flex-wrap items-center gap-1.5 leading-relaxed">
                  <span className="font-mono font-semibold">[{f.code}]</span>
                  <code className="rounded-xs border border-(--color-border) bg-(--bg-key) px-1 py-0.5 font-mono text-[11px] text-(--color-text)">
                    {f.path}
                  </code>
                  <span>{f.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Split pane: File list + Editor */}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row overflow-hidden border-t border-(--color-border) bg-(--bg-page)">
        {/* Left pane: File list */}
        <div className="flex w-full md:w-60 lg:w-64 shrink-0 flex-col border-b md:border-b-0 md:border-r border-(--color-border) bg-(--bg-sidebar)">
          <div className="flex h-8.5 shrink-0 items-center justify-between border-b border-(--color-border)/60 bg-(--bg-key)/30 px-3 select-none">
            <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-(--color-text-subtle)">
              Pages ({treeData?.pages.length ?? 0})
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setNewFileOpen(true)}
                    className="h-6 w-6 text-(--color-text-muted) hover:text-(--color-text)"
                    aria-label="New Page"
                  >
                    <Plus size={12} aria-hidden="true" />
                  </Button>
                }
              />
              <TooltipContent>New Page</TooltipContent>
            </Tooltip>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5 space-y-0.5">
            {treeLoading ? (
              <p className="p-3 text-center font-mono text-xs text-(--color-text-muted)">
                Loading pages…
              </p>
            ) : treeData?.pages.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-6 text-center">
                <p className="text-xs text-(--color-text-muted)">No memory pages yet.</p>
                <Button
                  variant="subtle"
                  size="xs"
                  onClick={() => setNewFileOpen(true)}
                  className="mt-2.5"
                >
                  <Plus size={11} aria-hidden="true" />
                  Create page
                </Button>
              </div>
            ) : (
              treeData?.pages.map((p) => {
                const active = selectedPath === p.path
                return (
                  <button
                    key={p.path}
                    type="button"
                    onClick={() => setSelectedPath(p.path)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group flex w-full items-center gap-2 rounded-xs px-2.5 py-1.5 text-left text-xs transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40',
                      active
                        ? 'border border-(--color-border-strong) bg-(--bg-key)/70 font-semibold text-(--color-text)'
                        : 'border border-transparent text-(--color-text-muted) hover:bg-(--bg-key)/40 hover:text-(--color-text)',
                    )}
                  >
                    <FileText
                      size={12}
                      className={cn(
                        'shrink-0 transition-colors',
                        active ? 'text-(--color-text)' : 'text-(--color-text-muted)',
                      )}
                      aria-hidden="true"
                    />
                    <span className="truncate font-mono text-[11px]">{p.path}</span>
                  </button>
                )
              })
            )}
          </div>
        </div>

        {/* Right pane: Editor */}
        <div className="flex min-h-0 flex-1 flex-col bg-(--bg-card)">
          {selectedPath ? (
            <>
              <div className="flex h-8.5 shrink-0 items-center justify-between border-b border-(--color-border) bg-(--bg-key)/20 px-3 select-none">
                <div className="flex min-w-0 items-center gap-2 truncate">
                  <FileText size={12} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
                  <span className="truncate font-mono text-xs font-semibold text-(--color-text)">
                    {selectedPath}
                  </span>
                  {fileData?.etag && (
                    <span
                      title={`ETag: ${fileData.etag}`}
                      className="shrink-0 rounded-xs border border-(--color-border) bg-(--bg-key) px-1.5 py-0.5 font-mono text-[10px] text-(--color-text-subtle) select-none"
                    >
                      {fileData.etag.slice(1, 9)}...
                    </span>
                  )}
                  {isDirty && (
                    <span className="hidden items-center gap-1 font-mono text-[10px] text-(--color-text-muted) sm:inline-flex">
                      <span
                        className="h-1.5 w-1.5 rounded-full bg-(--color-text) animate-pulse"
                        aria-hidden="true"
                      />
                      Unsaved
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setDeleteOpen(true)}
                    className="text-(--color-error) hover:bg-(--color-error-subtle) hover:text-(--color-error)"
                  >
                    <Trash2 size={11} aria-hidden="true" />
                    <span>Delete</span>
                  </Button>
                  <Button
                    variant="primary"
                    size="xs"
                    onClick={handleSave}
                    disabled={!isDirty || saveMut.isPending}
                  >
                    <Save size={11} aria-hidden="true" />
                    <span>{saveMut.isPending ? 'Saving…' : 'Save'}</span>
                  </Button>
                </div>
              </div>
              <div className="relative flex min-h-0 flex-1 flex-col">
                {fileLoading ? (
                  <p className="p-4 text-center font-mono text-xs text-(--color-text-muted)">
                    Loading content…
                  </p>
                ) : (
                  <textarea
                    value={draftContent}
                    onChange={(e) => setDraftContent(e.target.value)}
                    placeholder="Markdown content..."
                    spellCheck={false}
                    className="h-full w-full min-h-0 flex-1 resize-none border-0 bg-transparent p-3 font-mono text-xs leading-relaxed text-(--color-text) placeholder:text-(--color-text-muted) outline-none focus:outline-none focus-visible:outline-none"
                  />
                )}
              </div>
            </>
          ) : (
            <div className="flex h-full flex-1 flex-col items-center justify-center p-6 text-center select-none">
              <Brain
                size={28}
                className="mb-2 text-(--color-text-muted) opacity-30"
                aria-hidden="true"
              />
              <p className="text-xs font-semibold text-(--color-text)">No page selected</p>
              <p className="mt-1 text-[11px] text-(--color-text-muted)">
                Select a memory page to edit or create a new one.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Conflict Dialog (412 Precondition Failed) */}
      <Dialog open={conflictOpen} onOpenChange={setConflictOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Conflict Detected</DialogTitle>
            <DialogDescription>
              This memory file was modified externally or by the agent. Reload to see the latest
              changes?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 flex justify-end gap-2">
            <Button variant="subtle" size="sm" onClick={() => setConflictOpen(false)}>
              Keep My Draft
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={async () => {
                const reloaded = await refetchFile()
                if (reloaded.data) {
                  setDraftContent(reloaded.data.content)
                }
                setConflictOpen(false)
                push({ tone: 'info', title: 'Reloaded file from disk' })
              }}
            >
              Reload File
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Memory Page</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{' '}
              <code className="rounded-xs border border-(--color-border) bg-(--bg-key) px-1 py-0.5 font-mono text-[11px] text-(--color-text)">
                {selectedPath}
              </code>
              ? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 flex justify-end gap-2">
            <Button variant="subtle" size="sm" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" onClick={handleDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New File Dialog */}
      <Dialog open={newFileOpen} onOpenChange={setNewFileOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Memory Page</DialogTitle>
            <DialogDescription>
              Enter the page path relative to global memory (e.g.{' '}
              <code className="rounded-xs border border-(--color-border) bg-(--bg-key) px-1 py-0.5 font-mono text-[11px] text-(--color-text)">
                topics/database.md
              </code>
              ).
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Input
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              placeholder="topics/new-page.md"
              className="font-mono text-xs"
              autoFocus
            />
          </div>
          <DialogFooter className="mt-4 flex justify-end gap-2">
            <Button variant="subtle" size="sm" onClick={() => setNewFileOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!newFileName.trim()}
              onClick={handleCreateNew}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
