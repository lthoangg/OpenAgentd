import { useState } from 'react'
import type { FrontmatterField, FrontmatterValue } from './frontmatter'

/** Fields shown before the table offers "Show all". */
export const FRONTMATTER_COLLAPSED_ROWS = 8

/**
 * A markdown file's YAML frontmatter as a two-column key/value table, shown
 * above the rendered body in the File preview. `fields === null` means the
 * YAML was not plain enough to tabulate, so it is shown as source instead.
 */
export function FrontmatterTable({ fields, raw }: { fields: FrontmatterField[] | null; raw: string }) {
  const [expanded, setExpanded] = useState(false)

  if (fields === null) {
    return (
      <section aria-label="Frontmatter" className="mb-4">
        <RawYaml text={raw} />
      </section>
    )
  }
  if (fields.length === 0) return null

  const collapsible = fields.length > FRONTMATTER_COLLAPSED_ROWS
  const shown = collapsible && !expanded ? fields.slice(0, FRONTMATTER_COLLAPSED_ROWS) : fields

  return (
    <section aria-label="Frontmatter" className="mb-4 overflow-hidden rounded-md border border-(--color-border) text-xs">
      <table className="w-full table-fixed border-collapse">
        <tbody>
          {shown.map((field, index) => (
            <tr key={`${index}-${field.key}`} className="border-(--color-border) not-last:border-b">
              <th
                scope="row"
                className="w-[28%] max-w-48 bg-(--bg-key) px-2.5 py-1.5 text-left align-top font-mono font-normal break-words text-(--color-text-2)"
              >
                {field.key}
              </th>
              <td className="min-w-0 px-2.5 py-1.5 align-top text-(--color-text-2)">
                <FieldValue value={field.value} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {collapsible && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="w-full border-t border-(--color-border) px-2.5 py-1 text-left text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text-2)"
        >
          {expanded ? 'Show fewer fields' : `Show all ${fields.length} fields`}
        </button>
      )}
    </section>
  )
}

function FieldValue({ value }: { value: FrontmatterValue }) {
  if (value.kind === 'raw') return <RawYaml text={value.text} />
  if (value.kind === 'list') {
    if (value.items.length === 0) return <span className="text-(--color-text-subtle)">—</span>
    return (
      <ul className="flex flex-wrap gap-1">
        {value.items.map((item, index) => (
          <li key={`${index}-${item}`} className="rounded-xs bg-(--bg-key) px-1.5 py-px font-mono break-all">
            {item}
          </li>
        ))}
      </ul>
    )
  }
  if (!value.text) return <span className="text-(--color-text-subtle)">—</span>
  return <span className="whitespace-pre-line break-words">{value.text}</span>
}

function RawYaml({ text }: { text: string }) {
  return (
    <pre className="max-h-48 overflow-auto rounded-sm bg-(--bg-key) px-2 py-1.5 font-mono text-xs whitespace-pre text-(--color-text-2)">
      {text}
    </pre>
  )
}
