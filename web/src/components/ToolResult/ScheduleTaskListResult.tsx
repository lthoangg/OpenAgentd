/**
 * A schedule list result: the scheduled tasks as a table of name, schedule,
 * status, runs and next run. Any other schedule output reads as text.
 */

import { GenericResult } from './GenericResult'

interface ScheduledTaskRow {
  slug: string
  name: string
  schedule: string
  status: string
  runs: string
  next?: string
}

function parseScheduledTaskList(result: string): ScheduledTaskRow[] | null {
  if (!result.startsWith('Scheduled tasks (')) return null

  const rows = result.split('\n').slice(1).flatMap((line) => {
    const fields = new Map(
      line.trim().split('|').map((part) => {
        const separator = part.indexOf('=')
        return separator >= 0
          ? [part.slice(0, separator).trim(), part.slice(separator + 1).trim()]
          : ['', '']
      }),
    )
    const name = fields.get('name')
    const schedule = fields.get('schedule')
    const status = fields.get('status')
    const runs = fields.get('runs')
    if (!name || !schedule || !status || !runs) return []
    return [{
      slug: fields.get('slug') ?? '',
      name,
      schedule: schedule.replaceAll("'", ''),
      status,
      runs,
      next: fields.get('next'),
    }]
  })

  return rows.length > 0 ? rows : null
}

export function ScheduleTaskListResult({ result }: { result: string }) {
  const rows = parseScheduledTaskList(result)
  if (!rows) return <GenericResult result={result} />

  return (
    <div className="oa-table-wrap">
      <table className="w-full min-w-max font-mono text-xs leading-relaxed text-(--color-text-2)">
        <thead className="border-b border-(--color-border) bg-(--bg-key) text-left label-caps text-(--color-text-muted)">
          <tr>
            <th className="px-3 py-1.5 font-semibold">Task</th>
            <th className="px-3 py-1.5 font-semibold">Schedule</th>
            <th className="px-3 py-1.5 font-semibold">Status</th>
            <th className="px-3 py-1.5 font-semibold">Runs</th>
            <th className="px-3 py-1.5 font-semibold">Next</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((task) => (
            <tr key={task.slug || task.name} className="border-b border-(--color-border) last:border-b-0">
              <td className="px-3 py-2 align-top text-(--color-text)">
                <div>{task.name}</div>
                {task.slug && <div className="text-xs md:text-meta text-(--color-text-muted)">{task.slug}</div>}
              </td>
              <td className="px-3 py-2 align-top">{task.schedule}</td>
              <td className="px-3 py-2 align-top">{task.status}</td>
              <td className="px-3 py-2 align-top">{task.runs}</td>
              <td className="px-3 py-2 align-top">{task.next ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
