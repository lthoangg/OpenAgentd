/**
 * EditorDeleteRow — the one place an editor deletes what it edits (a
 * subagent, a skill, a connector): a row in its own card at the bottom of
 * the editor, "Delete <thing>" with what it removes, and a "Delete…" button
 * that opens the editor's confirmation. Every editor shows it the same way.
 */
import { Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { PanelRow } from '@/components/ui/panel-row'
import { SectionCard } from '@/components/ui/section-card'

export function EditorDeleteRow({ thing, description, onDelete, pending = false }: {
  /** What is deleted, in words: "subagent", "skill", "connector". */
  thing: string
  /** What deleting removes, in one sentence. */
  description: string
  /** Opens the confirmation. */
  onDelete: () => void
  pending?: boolean
}) {
  return (
    <SectionCard className="mt-6 md:mt-8" data-editor-delete="">
      <PanelRow label={`Delete ${thing}`} description={description}>
        <Button variant="danger-subtle" size="sm" onClick={onDelete} disabled={pending}>
          <Trash2 size={12} aria-hidden="true" />
          {pending ? 'Deleting…' : 'Delete…'}
        </Button>
      </PanelRow>
    </SectionCard>
  )
}
