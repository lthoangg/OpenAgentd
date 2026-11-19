/**
 * Settings → Memory — persistent Markdown memory viewer, editor, and linter.
 *
 * Edits wait for the settings save bar, as on every page with an editor:
 * opening another page, closing Settings or leaving the section with unsaved
 * edits asks first. A phone edits a page full screen, with Save in its bar.
 */
import { useState, useEffect, useRef } from 'react'
import {
  Brain,
  FileText,
  Plus,
  RefreshCw,
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
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { SettingsPage } from '@/components/settings/SettingsPage'
import type { DraftControls } from '@/components/settings/useSettingsDraft'
import { cn } from '@/lib/utils'
import { createPortal } from 'react-dom'
import { PhoneNavBar } from '@/components/phone/PhoneNavBar'
import { useIsPhone } from '@/hooks/use-is-phone'

/** The phone editor's formatting bar: text it wraps the selection in. */
const MARKDOWN_TOOLS = [
  { label: 'Heading', text: '#', before: '# ', after: '' },
  { label: 'Bold', text: 'B', before: '**', after: '**' },
  { label: 'List item', text: '–', before: '- ', after: '' },
  { label: 'Code', text: '`', before: '`', after: '`' },
  { label: 'Link', text: '[ ]', before: '[', after: ']()' },
] as const

export function MemorySettingsPage() {
  const push = useToastStore((s) => s.push)

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [draftContent, setDraftContent] = useState<string>('')
  const [newFileOpen, setNewFileOpen] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [newFileError, setNewFileError] = useState<string | null>(null)
  // A page the user asked to open while the current one has unsaved edits.
  const [pendingPath, setPendingPath] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [conflictOpen, setConflictOpen] = useState(false)
  // A phone edits a page full screen, Save in its bar (mockup J10 10.5).
  const isPhone = useIsPhone()
  const [phoneEditing, setPhoneEditing] = useState(false)
  const editorRef = useRef<HTMLTextAreaElement>(null)

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

  // The draft follows the loaded page until it is edited: a refetch (the
  // agent saved the page, the window regained focus) must never replace
  // what the user typed. A conflict surfaces on Save instead (412).
  const baselineRef = useRef<{ path: string | null; content: string | null }>({ path: null, content: null })
  useEffect(() => {
    if (!fileData || !selectedPath) return
    const base = baselineRef.current
    const edited = base.path === selectedPath && base.content !== null && draftContent !== base.content
    baselineRef.current = { path: selectedPath, content: fileData.content }
    if (!edited) setDraftContent(fileData.content)
    // Only a new snapshot rebases; typing must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileData, selectedPath])

  // Only a loaded page can be dirty: while a page loads or fails to load the
  // editor holds no content of its own, so Save must never write it back.
  const isDirty = fileData ? draftContent !== fileData.content : false

  /** Opens another page, asking first when the open one has unsaved edits. */
  const openPage = (path: string) => {
    if (path === selectedPath) return
    if (isDirty) {
      setPendingPath(path)
      return
    }
    selectPage(path)
  }
  const selectPage = (path: string | null) => {
    baselineRef.current = { path: null, content: null }
    setDraftContent('')
    setSelectedPath(path)
  }

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

  // The page's edits, for the settings save bar (Discard…, Save, ⌘S).
  const draft: DraftControls = {
    dirty: isDirty,
    canSave: Boolean(selectedPath && fileData && isDirty && !saveMut.isPending),
    isSaving: saveMut.isPending,
    save: handleSave,
    reset: () => { if (fileData) setDraftContent(fileData.content) },
  }

  // A second press while the first request is in flight does nothing: the
  // buttons only read as disabled once the mutation has re-rendered them.
  const inFlight = useRef(false)

  const handleDelete = async () => {
    if (!selectedPath || !fileData || inFlight.current) return
    inFlight.current = true
    try {
      await deleteMut.mutateAsync({
        path: selectedPath,
        ifMatch: fileData.etag,
      })
      push({ tone: 'success', title: `Deleted "${selectedPath}"` })
      setDeleteOpen(false)
      selectPage(null)
      refetchTree()
    } catch (err) {
      if (err instanceof ApiValidationError && err.status === 412) {
        setConflictOpen(true)
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        push({ tone: 'error', title: 'Delete failed', description: msg })
      }
    } finally {
      inFlight.current = false
    }
  }

  const handleCreateNew = async () => {
    let filename = newFileName.trim()
    if (!filename || inFlight.current) return
    if (!filename.endsWith('.md')) filename += '.md'
    // Creating writes a starter page: never over one that exists.
    if (treeData?.pages.some((page) => page.path === filename)) {
      setNewFileError(`${filename} already exists. Open it from the list, or choose another path.`)
      return
    }
    inFlight.current = true
    try {
      await saveMut.mutateAsync({
        path: filename,
        content: `# ${filename.replace('.md', '')}\n\n`,
      })
      push({ tone: 'success', title: `Created "${filename}"` })
      setNewFileOpen(false)
      setNewFileName('')
      selectPage(filename)
      refetchTree()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      push({ tone: 'error', title: 'Create failed', description: msg })
    } finally {
      inFlight.current = false
    }
  }

  const handleRunLint = async () => {
    setIsLinting(true)
    try {
      const report = await lintMemory()
      setLintFindings(report.findings)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      push({ tone: 'error', title: "Couldn't check links", description: msg })
    } finally {
      setIsLinting(false)
    }
  }

  return (
    <SettingsPage
      title="Memory"
      layout="fill"
      description="Markdown notes and standing directives that agents share across workspaces."
      draft={draft}
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
          className="mb-4"
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
                  <code className="rounded-xs border border-(--color-border) bg-(--bg-key) px-1 py-0.5 font-mono text-meta text-(--color-text)">
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
      <div className="mb-6 flex min-h-0 flex-1 flex-col overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-page) lg:flex-row">
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
                  <Plus size={12} aria-hidden="true" />
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
                    onClick={() => { openPage(p.path); if (isPhone && !isDirty) setPhoneEditing(true) }}
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
                    <span className="truncate font-mono text-meta">{p.path}</span>
                  </button>
                )
              })
            )}
          </div>
        </div>

        {/* Right pane: Editor (a phone opens it full screen instead) */}
        <div className={cn('flex min-h-0 flex-1 flex-col bg-(--bg-card)', isPhone && 'hidden')}>
          {selectedPath ? (
            <>
              <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-(--color-border-subtle) pr-2 pl-4 select-none">
                <div className="flex min-w-0 items-center gap-2 truncate">
                  <FileText size={12} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
                  <span className="truncate font-mono text-xs font-semibold text-(--color-text)">
                    {selectedPath}
                  </span>
                  {isDirty && (
                    <span className="hidden items-center gap-1 font-mono text-xs md:text-meta text-(--color-text-muted) sm:inline-flex">
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
                    placeholder="Markdown content…"
                    spellCheck={false}
                    className="h-full w-full min-h-0 flex-1 resize-none border-0 bg-transparent px-4 py-3.5 font-mono text-xs leading-relaxed text-(--color-text) placeholder:text-(--color-text-muted) outline-none focus:outline-none focus-visible:outline-none"
                  />
                )}
              </div>
            </>
          ) : (
            <div className="flex h-full flex-1 flex-col items-center justify-center p-6 text-center select-none">
              <Brain
                size={16}
                className="mb-2 text-(--color-text-muted) opacity-30"
                aria-hidden="true"
              />
              <p className="text-xs font-semibold text-(--color-text)">No page selected</p>
              <p className="mt-1 text-meta text-(--color-text-muted)">
                Select a memory page to edit or create a new one.
              </p>
            </div>
          )}
        </div>
      </div>

      {isPhone && phoneEditing && selectedPath && createPortal(
        // Portaled out of the shell, so it follows the visual viewport itself
        // (``--app-vh``/``--app-vt``, as the shell does): with the keyboard up
        // the editor and its formatting bar end on top of it, not under it.
        <div data-memory-editor="phone" className="fixed inset-x-0 top-0 z-60 flex h-(--app-vh,100svh) translate-y-(--app-vt,0px) flex-col bg-(--bg-page) pt-safe pb-safe">
          <PhoneNavBar
            back={{ label: 'Memory', onBack: () => setPhoneEditing(false) }}
            title={<span className="font-mono">{selectedPath}</span>}
            trailing={(
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleSave}
                disabled={!fileData || !isDirty || saveMut.isPending}
                className="font-semibold text-(--color-accent)!"
              >
                {saveMut.isPending ? 'Saving…' : 'Save'}
              </Button>
            )}
          />
          <textarea
            ref={editorRef}
            aria-label={`Edit ${selectedPath}`}
            value={draftContent}
            onChange={(e) => setDraftContent(e.target.value)}
            disabled={!fileData}
            placeholder={fileLoading ? 'Loading…' : 'Markdown content…'}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none border-0 bg-transparent px-4 py-3 font-mono text-code leading-relaxed text-(--color-text) outline-none"
          />
          {/* The formatting bar, just above the keyboard. */}
          <div role="toolbar" aria-label="Formatting" className="flex shrink-0 items-center gap-1 border-t border-(--color-border) px-2 py-1">
            {MARKDOWN_TOOLS.map((tool) => (
              <Button
                key={tool.label}
                type="button"
                variant="ghost"
                size="sm"
                aria-label={tool.label}
                // Keep the keyboard up: the tap must not blur the editor.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  const el = editorRef.current
                  if (!el) return
                  const { selectionStart: a, selectionEnd: b } = el
                  const next = draftContent.slice(0, a) + tool.before + draftContent.slice(a, b) + tool.after + draftContent.slice(b)
                  setDraftContent(next)
                  requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + tool.before.length, b + tool.before.length) })
                }}
                className="font-mono"
              >
                {tool.text}
              </Button>
            ))}
          </div>
        </div>,
        document.body,
      )}

      <ConfirmDialog
        open={pendingPath !== null}
        onOpenChange={(open) => { if (!open) setPendingPath(null) }}
        title="Discard changes?"
        description={`Your unsaved edits to ${selectedPath ?? 'this page'} will be lost.`}
        confirmLabel="Discard changes"
        onConfirm={() => {
          const next = pendingPath
          setPendingPath(null)
          if (next) {
            selectPage(next)
            if (isPhone) setPhoneEditing(true)
          }
        }}
      />

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
          <DialogFooter>
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
        <DialogContent size="md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete this memory page?</DialogTitle>
            <DialogDescription>
              Agents lose{' '}
              <code className="rounded-xs border border-(--color-border) bg-(--bg-key) px-1 py-0.5 font-mono text-meta text-(--color-text)">
                {selectedPath}
              </code>
 and its notes. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setDeleteOpen(false)} disabled={deleteMut.isPending}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDelete} disabled={deleteMut.isPending}>
              Delete page
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New File Dialog */}
      <Dialog open={newFileOpen} onOpenChange={(open) => { setNewFileOpen(open); if (!open) setNewFileError(null) }}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>New memory page</DialogTitle>
            <DialogDescription>
              Enter the page path relative to global memory (e.g.{' '}
              <code className="rounded-xs border border-(--color-border) bg-(--bg-key) px-1 py-0.5 font-mono text-meta text-(--color-text)">
                topics/database.md
              </code>
              ).
            </DialogDescription>
          </DialogHeader>
          {/* A form, so Enter in the field creates the page as the button does. */}
          <form onSubmit={(event) => { event.preventDefault(); void handleCreateNew() }}>
            <div className="py-2">
              <Input
                value={newFileName}
                onChange={(e) => { setNewFileName(e.target.value); setNewFileError(null) }}
                placeholder="topics/new-page.md"
                aria-label="Page path"
                aria-invalid={newFileError !== null}
                aria-describedby={newFileError ? 'memory-new-page-error' : undefined}
                className="font-mono text-xs"
                enterKeyHint="done"
                spellCheck={false}
                autoFocus
              />
              {newFileError && <p id="memory-new-page-error" role="alert" className="mt-2 text-meta text-(--color-error)">{newFileError}</p>}
            </div>
            <DialogFooter>
              <Button type="button" onClick={() => setNewFileOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={!newFileName.trim() || saveMut.isPending}>
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </SettingsPage>
  )
}
