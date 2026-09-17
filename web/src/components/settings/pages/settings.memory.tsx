/**
 * /settings/memory — Persistent Markdown memory viewer, editor, and linter.
 */
import { useState, useEffect } from 'react'
import { AlertCircle, Brain, CheckCircle2, FileText, Plus, RefreshCw, Trash2 } from 'lucide-react'

import {
  useMemoryTreeQuery,
  useMemoryFileQuery,
  useSaveMemoryFileMutation,
  useDeleteMemoryFileMutation,
} from '@/queries'
import {
  lintMemory,
  ApiValidationError,
  type MemoryScopeKind,
  type MemoryFindingItem,
} from '@/api/client'
import { useAgentStore } from '@/stores/useAgentStore'
import { useToastStore } from '@/stores/useToastStore'
import { isChatWorkspacePath } from '@/queries/useChatWorkspace'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

export function MemorySettingsPage() {
  const push = useToastStore((s) => s.push)
  const rawWorkspace = useAgentStore((s) => s._workspace)
  const isChat = isChatWorkspacePath(rawWorkspace)
  const workspace = isChat ? null : rawWorkspace

  const [scope, setScope] = useState<MemoryScopeKind>('global')
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
  } = useMemoryTreeQuery(scope, workspace)

  const {
    data: fileData,
    isLoading: fileLoading,
    refetch: refetchFile,
  } = useMemoryFileQuery(selectedPath, scope, workspace)

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

  const handleSave = async () => {
    if (!selectedPath) return
    try {
      await saveMut.mutateAsync({
        path: selectedPath,
        content: draftContent,
        scope,
        ifMatch: fileData?.etag,
        workspace,
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

  const handleDelete = async () => {
    if (!selectedPath || !fileData) return
    try {
      await deleteMut.mutateAsync({
        path: selectedPath,
        scope,
        ifMatch: fileData.etag,
        workspace,
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
        scope,
        workspace,
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
      const report = await lintMemory(workspace)
      setLintFindings(report.findings)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      push({ tone: 'error', title: 'Lint check failed', description: msg })
    } finally {
      setIsLinting(false)
    }
  }

  const isDirty = fileData ? draftContent !== fileData.content : draftContent.length > 0

  return (
    <div className="flex h-full flex-col space-y-4 p-6 text-(--text-primary)">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-(--border) pb-4">
        <div className="flex items-center space-x-3">
          <Brain className="h-6 w-6 text-(--text-primary)" />
          <div>
            <h1 className="text-lg font-semibold">Memory</h1>
            <p className="text-xs text-(--text-secondary)">
              Persistent human-editable Markdown knowledge base and standing directives.
            </p>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <Button
            variant="subtle"
            size="sm"
            onClick={handleRunLint}
            disabled={isLinting}
            className="flex items-center space-x-1 text-xs"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isLinting && 'animate-spin')} />
            <span>{isLinting ? 'Linting...' : 'Run Lint'}</span>
          </Button>
        </div>
      </div>

      {/* Lint findings banner */}
      {lintFindings !== null && (
        <div
          className={cn(
            'rounded-md p-3 text-xs',
            lintFindings.length === 0
              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
              : 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20',
          )}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2 font-medium">
              {lintFindings.length === 0 ? (
                <>
                  <CheckCircle2 className="h-4 w-4" />
                  <span>All memory pages and wikilinks are valid.</span>
                </>
              ) : (
                <>
                  <AlertCircle className="h-4 w-4" />
                  <span>{lintFindings.length} issue(s) found:</span>
                </>
              )}
            </div>
            <button
              onClick={() => setLintFindings(null)}
              className="text-xs underline hover:no-underline"
            >
              Dismiss
            </button>
          </div>
          {lintFindings.length > 0 && (
            <ul className="mt-2 list-inside list-disc space-y-1">
              {lintFindings.map((f, i) => (
                <li key={i}>
                  <strong>[{f.code}]</strong> <code className="font-mono">{f.path}</code>: {f.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Scope toggle */}
      <div className="flex items-center space-x-2 border-b border-(--border) pb-2">
        <button
          type="button"
          onClick={() => {
            setScope('global')
            setSelectedPath(null)
          }}
          className={cn(
            'px-3 py-1 text-xs font-medium rounded-md transition-colors',
            scope === 'global'
              ? 'bg-(--bg-selection) text-(--text-primary)'
              : 'text-(--text-secondary) hover:text-(--text-primary)',
          )}
        >
          Global Memory
        </button>
        <button
          type="button"
          onClick={() => {
            if (!isChat) {
              setScope('workspace')
              setSelectedPath(null)
            }
          }}
          disabled={isChat}
          title={isChat ? 'Workspace memory is unavailable in Chat mode' : undefined}
          className={cn(
            'px-3 py-1 text-xs font-medium rounded-md transition-colors',
            scope === 'workspace'
              ? 'bg-(--bg-selection) text-(--text-primary)'
              : 'text-(--text-secondary) hover:text-(--text-primary)',
            isChat && 'opacity-40 cursor-not-allowed',
          )}
        >
          Workspace Memory {isChat && '(Chat mode)'}
        </button>
      </div>

      {/* Split pane */}
      <div className="flex flex-1 overflow-hidden rounded-md border border-(--border)">
        {/* Left pane: File list */}
        <div className="flex w-64 flex-col border-r border-(--border) bg-(--bg-sidebar)">
          <div className="flex items-center justify-between border-b border-(--border) p-2">
            <span className="text-xs font-medium text-(--text-secondary) uppercase tracking-wider">
              Pages ({treeData?.pages.length ?? 0})
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setNewFileOpen(true)}
              className="h-6 w-6 p-0"
              title="New Page"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-1 space-y-0.5">
            {treeLoading ? (
              <p className="p-3 text-xs text-(--text-tertiary)">Loading pages...</p>
            ) : treeData?.pages.length === 0 ? (
              <p className="p-3 text-xs text-(--text-tertiary)">No memory pages yet.</p>
            ) : (
              treeData?.pages.map((p) => (
                <button
                  key={p.path}
                  type="button"
                  onClick={() => setSelectedPath(p.path)}
                  className={cn(
                    'flex w-full items-center space-x-2 rounded px-2 py-1.5 text-left text-xs transition-colors',
                    selectedPath === p.path
                      ? 'bg-(--bg-selection) text-(--text-primary) font-medium'
                      : 'text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary)',
                  )}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  <span className="truncate">{p.path}</span>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Right pane: Editor */}
        <div className="flex flex-1 flex-col bg-(--bg-card)">
          {selectedPath ? (
            <>
              <div className="flex items-center justify-between border-b border-(--border) px-4 py-2">
                <div className="flex items-center space-x-2 truncate">
                  <span className="font-mono text-xs font-medium text-(--text-primary)">
                    {selectedPath}
                  </span>
                  {fileData?.etag && (
                    <span className="rounded bg-(--bg-key) px-1.5 py-0.5 font-mono text-[10px] text-(--text-tertiary)">
                      {fileData.etag.slice(1, 9)}...
                    </span>
                  )}
                </div>
                <div className="flex items-center space-x-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDeleteOpen(true)}
                    className="text-xs text-rose-500 hover:text-rose-600 hover:bg-rose-500/10"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                    Delete
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleSave}
                    disabled={!isDirty || saveMut.isPending}
                    className="text-xs"
                  >
                    {saveMut.isPending ? 'Saving...' : 'Save'}
                  </Button>
                </div>
              </div>
              <div className="flex-1 p-3">
                {fileLoading ? (
                  <p className="p-4 text-xs text-(--text-tertiary)">Loading content...</p>
                ) : (
                  <Textarea
                    value={draftContent}
                    onChange={(e) => setDraftContent(e.target.value)}
                    placeholder="Markdown content..."
                    className="h-full w-full resize-none font-mono text-xs leading-relaxed"
                  />
                )}
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-(--text-tertiary)">
              Select a memory page to edit or create a new one.
            </div>
          )}
        </div>
      </div>

      {/* Conflict Dialog (412 Precondition Failed) */}
      <Dialog open={conflictOpen} onOpenChange={setConflictOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Conflict Detected</DialogTitle>
            <DialogDescription>
              This memory file was modified externally or by the agent. Reload to see the latest changes?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 flex justify-end space-x-2">
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
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Memory Page</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <code className="font-mono">{selectedPath}</code>?
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 flex justify-end space-x-2">
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
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New Memory Page</DialogTitle>
            <DialogDescription>
              Enter the page path relative to {scope} memory (e.g. <code className="font-mono">topics/database.md</code>).
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Input
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              placeholder="topics/new-page.md"
              className="text-xs font-mono"
              autoFocus
            />
          </div>
          <DialogFooter className="mt-4 flex justify-end space-x-2">
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
