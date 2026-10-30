/**
 * /settings/memory — Persistent Markdown memory viewer, editor, and linter.
 */
import { useState, useEffect, useRef } from 'react'
import {
  Brain,
  FileText,
  Plus,
  RefreshCw,
  Save,
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
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ICON_SIZE_INLINE } from '@/components/settings/tokens'
import { Callout } from '@/components/ui/callout'
import { Skeleton } from '@/components/ui/skeleton'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { settingsRoot } from '@/components/settings/settings-root'
import { useShortcut } from '@/lib/keyboard/hooks'
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
    isError: treeError,
    refetch: refetchTree,
  } = useMemoryTreeQuery()

  const {
    data: fileData,
    isLoading: fileLoading,
    isError: fileError,
    error: fileErrorValue,
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

  // Only a loaded page can be dirty: while a page loads or fails to load the
  // editor holds no content of its own, so Save must never write it back.
  const isDirty = fileData ? draftContent !== fileData.content : false
  useUnsavedSettings(isDirty)

  const handleSave = async () => {
    if (!selectedPath || !fileData) return
    try {
      await saveMut.mutateAsync({
        path: selectedPath,
        content: draftContent,
        ifMatch: fileData.etag,
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

  // ⌘S / Ctrl+S saves the open file.
  useShortcut({ key: 'S', mod: true }, () => {
    const current = saveActionRef.current
    if (!current.selectedPath || !current.isDirty || current.isSaving) return false
    void current.handleSave()
  }, { within: settingsRoot })

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
      push({ tone: 'error', title: 'Could not check links', description: msg })
    } finally {
      setIsLinting(false)
    }
  }

  return (
    <SettingsPage
      title="Memory"
      layout="fill"
      description="Markdown notes and standing directives that agents share across workspaces."
      actions={
        <Button variant="default" size="sm" onClick={handleRunLint} disabled={isLinting}>
          <RefreshCw
            size={ICON_SIZE_INLINE}
            className={cn('shrink-0', isLinting && 'animate-spin')}
            aria-hidden="true"
          />
          {isLinting ? 'Checking…' : 'Check links'}
        </Button>
      }
    >
      {/* Lint findings banner */}
      {lintFindings !== null && (
        <Callout
          tone={lintFindings.length === 0 ? 'success' : 'warning'}
          role="status"
          className="mx-4 mb-4 md:mx-8"
          title={
            <span className="flex items-center justify-between gap-2">
              <span>
                {lintFindings.length === 0
                  ? 'All memory pages and wikilinks are valid.'
                  : `${lintFindings.length} ${lintFindings.length === 1 ? 'problem' : 'problems'} found`}
              </span>
              <button
                type="button"
                onClick={() => setLintFindings(null)}
                className="inline-flex cursor-pointer items-center text-xs font-normal underline hover:no-underline pointer-coarse:min-h-9 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
              >
                Dismiss
              </button>
            </span>
          }
        >
          {lintFindings.length > 0 && (
            <ul className="space-y-1.5">
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
        </Callout>
      )}

      {/* Split pane: File list + Editor */}
      <div className="mx-4 mb-6 flex min-h-0 flex-1 flex-col overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-page) md:mx-8 lg:flex-row">
        {/* Left pane: File list */}
        <div className="flex max-h-44 w-full shrink-0 flex-col border-b border-(--color-border) bg-(--bg-sidebar) lg:max-h-none lg:w-64 lg:border-r lg:border-b-0">
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-(--color-border-subtle) pr-2 pl-3 select-none">
            <span className="text-xs font-medium text-(--color-text-muted)">
              Pages <span className="tabular-nums text-(--color-text-subtle)">· {treeData?.pages.length ?? 0}</span>
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setNewFileOpen(true)}
              className="text-(--color-text-muted) hover:text-(--color-text)"
            >
              <Plus size={12} aria-hidden="true" />
              New page
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
            {treeLoading ? (
              <div className="space-y-1.5 p-1" role="status" aria-label="Loading pages">
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-6 w-2/3" />
                <Skeleton className="h-6 w-1/2" />
              </div>
            ) : treeError ? (
              <div className="flex flex-col items-center gap-2 p-4 text-center" role="alert">
                <p className="text-xs text-(--color-error)">Couldn&apos;t load memory pages.</p>
                <Button variant="default" size="xs" onClick={() => { void refetchTree() }}>Retry</Button>
              </div>
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
                      'group flex h-8 w-full items-center gap-2 rounded-sm px-2.5 text-left text-xs transition-colors pointer-coarse:h-9 pointer-coarse:text-sm',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)',
                      active
                        ? 'bg-(--bg-key) font-medium text-(--color-text)'
                        : 'text-(--color-text-muted) hover:bg-(--bg-key)/50 hover:text-(--color-text)',
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
              <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-(--color-border-subtle) pr-2 pl-4 select-none">
                <div className="flex min-w-0 items-center gap-2 truncate">
                  <FileText size={12} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
                  <span className="truncate font-mono text-xs font-semibold text-(--color-text)">
                    {selectedPath}
                  </span>
                  {isDirty && (
                    <span className="hidden items-center gap-1 font-mono text-xs md:text-[11px] text-(--color-text-muted) sm:inline-flex">
                      <span
                        className="h-1.5 w-1.5 rounded-full bg-(--color-text)"
                        aria-hidden="true"
                      />
                      Unsaved
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <Dropdown
                    aria-label={`More actions for ${selectedPath}`}
                    trigger="More"
                    align="end"
                    disabled={!fileData}
                    className="h-7 min-w-0 gap-1 border-transparent bg-transparent px-2 text-xs font-normal text-(--color-text-muted) shadow-none hover:bg-(--bg-key) hover:text-(--color-text)"
                  >
                    <DropdownItem onSelect={() => setDeleteOpen(true)} className="text-(--color-error)">
                      Delete page…
                    </DropdownItem>
                  </Dropdown>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleSave}
                    disabled={!fileData || !isDirty || saveMut.isPending}
                    title="Save (⌘S)"
                  >
                    <Save size={11} aria-hidden="true" />
                    <span>{saveMut.isPending ? 'Saving…' : 'Save'}</span>
                  </Button>
                </div>
              </div>
              <div className="relative flex min-h-0 flex-1 flex-col">
                {fileLoading ? (
                  <div className="space-y-2 p-4" role="status" aria-label="Loading page">
                    <Skeleton className="h-3 w-1/2" />
                    <Skeleton className="h-3 w-5/6" />
                    <Skeleton className="h-3 w-2/3" />
                  </div>
                ) : fileError || !fileData ? (
                  <div className="p-4">
                    <Callout
                      tone="error"
                      role="alert"
                      title={`Couldn't load ${selectedPath}`}
                      action={<Button size="sm" onClick={() => { void refetchFile() }}>Retry</Button>}
                    >
                      {fileErrorValue instanceof Error ? fileErrorValue.message : 'The page could not be read. Editing is off until it loads, so nothing is overwritten.'}
                    </Callout>
                  </div>
                ) : (
                  <textarea
                    value={draftContent}
                    onChange={(e) => setDraftContent(e.target.value)}
                    placeholder="Markdown content..."
                    spellCheck={false}
                    className="h-full w-full min-h-0 flex-1 resize-none border-0 bg-transparent px-4 py-3.5 font-mono text-xs leading-relaxed text-(--color-text) placeholder:text-(--color-text-muted) outline-none focus:outline-none focus-visible:outline-none"
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
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>This page changed elsewhere</DialogTitle>
            <DialogDescription>
              The agent or another program saved this page after you opened it. Reloading shows
              the latest version and discards your edits.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 flex justify-end gap-2">
            <Button onClick={() => setConflictOpen(false)}>
              Keep my draft
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                const reloaded = await refetchFile()
                if (reloaded.data) {
                  setDraftContent(reloaded.data.content)
                }
                setConflictOpen(false)
                push({ tone: 'info', title: 'Reloaded file from disk' })
              }}
            >
              Reload and discard edits
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Delete this memory page?</DialogTitle>
            <DialogDescription>
              Agents lose{' '}
              <code className="rounded-xs border border-(--color-border) bg-(--bg-key) px-1 py-0.5 font-mono text-[11px] text-(--color-text)">
                {selectedPath}
              </code>
 and its notes. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 flex justify-end gap-2">
            <Button onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDelete}>
              Delete page
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New File Dialog */}
      <Dialog open={newFileOpen} onOpenChange={setNewFileOpen}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>New memory page</DialogTitle>
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
            <Button onClick={() => setNewFileOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!newFileName.trim()}
              onClick={handleCreateNew}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPage>
  )
}
