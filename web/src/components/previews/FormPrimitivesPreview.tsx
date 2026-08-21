import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DateTimePicker } from '@/components/ui/date-time-picker'
import { Input } from '@/components/ui/input'
import {
  NumberInput,
  NumberInputField,
  NumberInputGroup,
  NumberInputStepper,
} from '@/components/ui/number-input'
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'

function PreviewField({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-(--color-text-muted)">
      {label}
      {children}
    </label>
  )
}

export function LowLevelComponentsPreview() {
  const [agent, setAgent] = useState('researcher')
  const [interval, setInterval] = useState<number | null>(3600)
  const [startsAt, setStartsAt] = useState('')
  const [enabled, setEnabled] = useState(true)

  return (
    <section className="grid gap-5 rounded-sm border border-(--color-border) bg-(--bg-card) p-5 text-(--color-text)">
      <div>
        <h2 className="font-hand text-3xl font-bold">Low-Level UI Components</h2>
        <p className="text-sm text-(--color-text-2)">Tokenized primitive controls from the OpenAgentd color panel.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <PreviewField label="Input">
          <Input placeholder="Task name" />
        </PreviewField>

        <PreviewField label="Select">
          <Dropdown value={agent} onValueChange={(value) => value && setAgent(value)} trigger="Agent" className="w-full">
            <DropdownItem value="researcher">Researcher</DropdownItem>
            <DropdownItem value="reviewer">Reviewer</DropdownItem>
            <DropdownItem value="writer">Writer</DropdownItem>
          </Dropdown>
        </PreviewField>

        <PreviewField label="Number input">
          <NumberInput value={interval} min={60} step={60} onValueChange={setInterval}>
            <NumberInputGroup>
              <NumberInputField aria-label="Interval seconds" />
              <NumberInputStepper />
            </NumberInputGroup>
          </NumberInput>
        </PreviewField>

        <PreviewField label="Date time picker">
          <DateTimePicker value={startsAt} onChange={setStartsAt} />
        </PreviewField>

        <div className="grid gap-2">
          <span className="text-xs font-medium text-(--color-text-muted)">Segmented</span>
          <Tabs defaultValue="every">
            <TabsList className="w-full">
              <TabsTrigger value="every">Every</TabsTrigger>
              <TabsTrigger value="cron">Cron</TabsTrigger>
              <TabsTrigger value="at">At</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="grid gap-2">
          <span className="text-xs font-medium text-(--color-text-muted)">Toggles</span>
          <div className="flex items-center gap-5 rounded-sm border border-(--color-border) bg-(--bg-page) px-3 py-2">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox defaultChecked /> Check
            </label>
            <RadioGroup defaultValue="one" className="flex gap-3">
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="one" /> One
              </label>
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="two" /> Two
              </label>
            </RadioGroup>
            <label className="ml-auto flex items-center gap-2 text-sm">
              <Switch checked={enabled} onCheckedChange={setEnabled} /> Enabled
            </label>
          </div>
        </div>

        <PreviewField label="Textarea">
          <Textarea placeholder="What should the agent do?" />
        </PreviewField>

        <div className="grid content-start gap-2">
          <span className="text-xs font-medium text-(--color-text-muted)">Popover</span>
          <Popover>
            <PopoverTrigger render={<Button variant="default">Open popover</Button>} />
            <PopoverContent align="start">
              <PopoverHeader>
                <PopoverTitle>Schedule conflict</PopoverTitle>
                <PopoverDescription>This task overlaps with Daily report. Adjust the time to continue.</PopoverDescription>
              </PopoverHeader>
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="ghost" size="sm">Dismiss</Button>
                <Button size="sm">Resolve</Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </section>
  )
}

export function CreateTaskFormPreview() {
  const [scheduleType, setScheduleType] = useState('every')
  const [enabled, setEnabled] = useState(true)

  return (
    <section className="max-w-lg rounded-sm border border-(--color-border) bg-(--bg-card) p-6 text-(--color-text) shadow-[0_8px_32px_rgba(26,23,20,0.12)]">
      <div className="mb-5">
        <h2 className="font-hand text-3xl font-bold">Create scheduled task</h2>
        <p className="text-sm text-(--color-text-2)">Composite preview assembled from the low-level primitives.</p>
      </div>

      <div className="grid gap-4">
        <PreviewField label="Name">
          <Input placeholder="Daily status report" />
        </PreviewField>

        <PreviewField label="Agent">
          <Dropdown value="researcher" onValueChange={() => {}} trigger="Agent" className="w-full">
            <DropdownItem value="researcher">Researcher</DropdownItem>
            <DropdownItem value="reviewer">Reviewer</DropdownItem>
            <DropdownItem value="writer">Writer</DropdownItem>
          </Dropdown>
        </PreviewField>

        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-(--color-text-muted)">Schedule type</span>
          <Tabs value={scheduleType} onValueChange={setScheduleType}>
            <TabsList className="w-full">
              <TabsTrigger value="every">Every</TabsTrigger>
              <TabsTrigger value="cron">Cron</TabsTrigger>
              <TabsTrigger value="at">At</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <PreviewField label="Interval seconds">
          <NumberInput defaultValue={3600} min={60} step={60}>
            <NumberInputGroup>
              <NumberInputField aria-label="Interval seconds" />
              <NumberInputStepper />
            </NumberInputGroup>
          </NumberInput>
        </PreviewField>

        <PreviewField label="Prompt">
          <Textarea placeholder="Summarize yesterday's work and draft today's priorities." />
        </PreviewField>

        <label className="flex items-center justify-between rounded-sm border border-(--color-border) bg-(--bg-page) px-3 py-2 text-sm">
          <span>
            Enabled
            <span className="block text-xs text-(--color-text-muted)">Run this schedule after saving.</span>
          </span>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="default">Cancel</Button>
          <Button>Save task</Button>
        </div>
      </div>
    </section>
  )
}
