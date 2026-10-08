import type { ScheduledTaskCreate } from '@/api/types'
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control'

type ScheduleType = ScheduledTaskCreate['schedule_type']

const OPTIONS: readonly SegmentedOption<ScheduleType>[] = [
  { value: 'every', label: 'Every' },
  { value: 'cron', label: 'Cron' },
  { value: 'at', label: 'At' },
]

export function ScheduleTypeSegmented({
  value,
  onChange,
}: {
  value: ScheduleType
  onChange: (v: ScheduleType) => void
}) {
  return <SegmentedControl label="Schedule type" value={value} onChange={onChange} options={OPTIONS} />
}
