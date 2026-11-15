/**
 * The task form's fields, shared by Create and Edit. Two pages: the first
 * asks what the task does, when, where, and where the reply goes; "More
 * options" holds the rest (a name, a run limit, the time zone, a session ID).
 * It is a second page, not a fold, and a failed submit opens the page that
 * holds the first problem (``pageWithErrors``).
 */
import { useMemo } from 'react'

import { Button } from '@/components/ui/button'
import { DateTimePicker } from '@/components/ui/date-time-picker'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { Input } from '@/components/ui/input'
import { TEXT } from '@/components/ui/panel-tokens'
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control'
import { Textarea } from '@/components/ui/textarea'
import { useSimpleDetail } from '@/stores/useDisplayPrefsStore'
import { formatInTimezone, isoToWallClock } from '@/utils/format'
import { loadWorkspaceEntries, workspaceLabel } from '@/utils/workspace'
import { previewCron } from './cron'
import { AtRunHint, CronField, IntervalField } from './ScheduleFields'
import { timedCron, titleFromPrompt, type SessionType, type TaskFormErrors, type TaskFormValues, type When } from './taskForm'
import { FIELD_CLASS, FIELD_ERROR, FIELD_HINT, FIELD_LABEL, slugify } from './utils'

export type TaskFormPage = 'main' | 'more'

const MORE_KEYS: readonly string[] = ['title', 'max_runs', 'customSessionId'] satisfies (keyof TaskFormValues)[]

/** The page to show after a failed submit: the current one if it holds a problem, else the other. */
export function pageWithErrors(errors: TaskFormErrors, page: TaskFormPage): TaskFormPage {
  const keys = Object.keys(errors)
  if (!keys.length) return page
  const onMore = keys.filter((key) => MORE_KEYS.includes(key)).length
  if (page === 'more') return onMore ? 'more' : 'main'
  return onMore === keys.length ? 'more' : 'main'
}

/**
 * The footer's way between the two pages. Enter in a field passes over it to
 * the submit button (``formNavigation``).
 */
export function TaskPageButton({ page, onChange }: { page: TaskFormPage; onChange: (page: TaskFormPage) => void }) {
  return (
    <Button type="button" variant="link" data-enter-skip="" className="mr-auto px-0" onClick={() => onChange(page === 'main' ? 'more' : 'main')}>
      {page === 'main' ? 'More options' : 'Back'}
    </Button>
  )
}

/** ``chosen`` is the trigger's text: it reads on into the controls beside it ("Every week on · Monday · at 09:00"). */
const WHEN_OPTIONS: readonly { value: When; label: string; chosen: string }[] = [
  { value: 'daily', label: 'Every day', chosen: 'Every day' },
  { value: 'weekdays', label: 'Every weekday', chosen: 'Every weekday' },
  { value: 'weekly', label: 'Every week on…', chosen: 'Every week on' },
  { value: 'interval', label: 'Every … minutes, hours or days', chosen: 'Every' },
  { value: 'once', label: 'Once, on…', chosen: 'Once, on' },
  { value: 'custom', label: 'Custom (cron)', chosen: 'Custom (cron)' },
]

/** Monday first; the value is the day as cron counts it. */
const WEEKDAYS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 0, label: 'Sunday' },
] as const

const DROPDOWN_CLASS = 'h-9 rounded-sm px-2.5 text-xs'

/** A segment whose label shortens in a narrow pane; its name is always the full one. */
function replyOption(value: SessionType, full: string, short: string): SegmentedOption<SessionType> {
  return {
    value,
    ariaLabel: full,
    label: (
      <>
        <span className="@xl:hidden">{short}</span>
        <span className="hidden @xl:inline">{full}</span>
      </>
    ),
  }
}

export function TaskFields({
  idPrefix,
  mode,
  page,
  values,
  set,
  fieldErrors,
  localTz,
  currentSessionTitle,
  sessionCompatible,
}: {
  /** ``task`` on the create form, ``edit-task`` on the edit form. */
  idPrefix: string
  mode: 'create' | 'edit'
  page: TaskFormPage
  values: TaskFormValues
  set: <K extends keyof TaskFormValues>(key: K, value: TaskFormValues[K]) => void
  fieldErrors: TaskFormErrors
  localTz: string
  currentSessionTitle: string | null
  /** The open session is in the task's workspace, so replies can go to it. */
  sessionCompatible: boolean
}) {
  const simple = useSimpleDetail()
  const id = (name: string) => `${idPrefix}-${name}`
  const timezone = values.timezone || localTz
  const runLabel = mode === 'create' ? 'First run' : 'Next run'
  const timed = values.when === 'daily' || values.when === 'weekdays' || values.when === 'weekly'

  const workspaces = useMemo(() => {
    const paths = loadWorkspaceEntries().map((entry) => entry.path)
    if (values.workspace && !paths.includes(values.workspace)) paths.push(values.workspace)
    return paths.sort()
  }, [values.workspace])

  if (page === 'more') {
    return (
      <div className="space-y-5">
        <h3 className={TEXT.title}>More options</h3>

        {mode === 'create' && (
          <div>
            <label htmlFor={id('title')} className={FIELD_LABEL}>Name</label>
            <Input
              id={id('title')}
              enterKeyHint="next"
              autoCapitalize="sentences"
              autoCorrect="on"
              className={`h-9 ${FIELD_CLASS}`}
              value={values.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder={values.prompt.trim() ? titleFromPrompt(values.prompt) : undefined}
              maxLength={100}
              aria-invalid={!!fieldErrors.title}
              aria-describedby={fieldErrors.title ? id('title-error') : id('title-help')}
            />
            {fieldErrors.title
              ? <p id={id('title-error')} className={FIELD_ERROR}>{fieldErrors.title}</p>
              : <p id={id('title-help')} className={FIELD_HINT}>Leave empty to name it after what it does.</p>}
            {/* The slug is the agent's schedule tool's name for the task: Full detail only. */}
            {!simple && values.title && (
              <div className="mt-2 flex items-center gap-1.5 text-meta text-(--color-text-muted)">
                <span>Slug:</span>
                <code className="rounded-xs border border-(--color-border-subtle) bg-(--bg-key)/80 px-1.5 py-0.5 font-mono text-xs md:text-meta text-(--color-text-2)">
                  {slugify(values.title)}
                </code>
              </div>
            )}
          </div>
        )}

        <div>
          <label htmlFor={id('max-runs')} className={FIELD_LABEL}>Stop after</label>
          <div className="flex items-center gap-2">
            <Input
              id={id('max-runs')}
              enterKeyHint="next"
              type="number"
              inputMode="numeric"
              min="1"
              className={`h-9 w-24! flex-none ${FIELD_CLASS}`}
              value={values.max_runs ?? ''}
              onChange={(e) => set('max_runs', e.target.value ? Number(e.target.value) : null)}
              placeholder="No limit"
              aria-invalid={!!fieldErrors.max_runs}
              aria-describedby={fieldErrors.max_runs ? id('max-runs-error') : id('max-runs-help')}
            />
            <span className="text-xs text-(--color-text-muted)">runs</span>
          </div>
          {fieldErrors.max_runs
            ? <p id={id('max-runs-error')} className={FIELD_ERROR}>{fieldErrors.max_runs}</p>
            : <p id={id('max-runs-help')} className={FIELD_HINT}>Leave empty to keep it running.</p>}
        </div>

        <div>
          <label htmlFor={id('timezone')} className={FIELD_LABEL}>Time zone</label>
          <Input
            id={id('timezone')}
            enterKeyHint="next"
            className={`h-9 ${FIELD_CLASS}`}
            value={values.timezone}
            onChange={(e) => set('timezone', e.target.value)}
            placeholder={localTz}
          />
        </div>

        <div>
          <label htmlFor={id('session-id')} className={FIELD_LABEL}>Session ID</label>
          <Input
            id={id('session-id')}
            // The last field: Enter moves to the submit button (formNavigation).
            enterKeyHint="done"
            className={`h-9 font-mono ${FIELD_CLASS}`}
            value={values.customSessionId}
            onChange={(e) => {
              set('customSessionId', e.target.value)
              if (e.target.value.trim()) set('sessionType', 'custom')
              else if (values.sessionType === 'custom') set('sessionType', 'new')
            }}
            placeholder="123e4567-e89b-12d3-a456-426614174000"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-invalid={!!fieldErrors.customSessionId}
            aria-describedby={fieldErrors.customSessionId ? id('session-id-error') : id('session-id-help')}
          />
          {fieldErrors.customSessionId
            ? <p id={id('session-id-error')} className={FIELD_ERROR}>{fieldErrors.customSessionId}</p>
            : <p id={id('session-id-help')} className={FIELD_HINT}>Send every reply to this session. Leave empty to choose on the first page.</p>}
        </div>
      </div>
    )
  }

  const nextTimed = timed && !fieldErrors.time
    ? previewCron(timedCron(values), isoToWallClock(new Date().toISOString(), timezone)).next
    : null
  // The scheduler counts the first interval from the save (create or edit).
  const nextInterval = values.when === 'interval' && values.every_seconds > 0
    ? formatInTimezone(new Date(Date.now() + values.every_seconds * 1000).toISOString(), localTz)
    : null

  const replyOptions: SegmentedOption<SessionType>[] = [
    replyOption('new', 'A new session each time', 'New each time'),
    replyOption('auto', 'The same session', 'The same'),
  ]
  if (sessionCompatible) replyOptions.push(replyOption('current', 'This session', 'This session'))
  if (values.sessionType === 'custom' || values.customSessionId.trim()) replyOptions.push(replyOption('custom', 'A specific session', 'By ID'))

  return (
    <div className="space-y-6">
      <div>
        <label htmlFor={id('prompt')} className={FIELD_LABEL}>What should it do?</label>
        <Textarea
          id={id('prompt')}
          className={`text-sm leading-relaxed ${FIELD_CLASS}`}
          value={values.prompt}
          onChange={(e) => set('prompt', e.target.value)}
          placeholder="Summarize what changed in this folder since yesterday."
          rows={3}
          aria-invalid={!!fieldErrors.prompt}
          aria-describedby={fieldErrors.prompt ? id('prompt-error') : undefined}
        />
        {fieldErrors.prompt && <p id={id('prompt-error')} className={FIELD_ERROR}>{fieldErrors.prompt}</p>}
      </div>

      <div>
        <label htmlFor={id('when')} className={FIELD_LABEL}>When?</label>
        <div className="flex flex-wrap items-center gap-2">
          <Dropdown
            id={id('when')}
            value={values.when}
            onValueChange={(v) => set('when', v as When)}
            renderValue={(v) => WHEN_OPTIONS.find((option) => option.value === v)?.chosen}
            trigger="When?"
            className={DROPDOWN_CLASS}
          >
            {WHEN_OPTIONS.map((option) => (
              <DropdownItem key={option.value} value={option.value}>{option.label}</DropdownItem>
            ))}
          </Dropdown>

          {values.when === 'weekly' && (
            <Dropdown
              value={String(values.weekday)}
              onValueChange={(v) => set('weekday', Number(v))}
              trigger="Day"
              aria-label="Day of the week"
              className={DROPDOWN_CLASS}
            >
              {WEEKDAYS.map((day) => (
                <DropdownItem key={day.value} value={String(day.value)}>{day.label}</DropdownItem>
              ))}
            </Dropdown>
          )}

          {timed && (
            <>
              <span className="text-xs text-(--color-text-muted)">at</span>
              <Input
                id={id('time')}
                type="time"
                enterKeyHint="next"
                className={`h-9 w-28! flex-none tabular-nums ${FIELD_CLASS}`}
                value={values.time}
                onChange={(e) => set('time', e.target.value)}
                aria-label="Time"
                aria-invalid={!!fieldErrors.time}
                aria-describedby={id('when-hint')}
              />
            </>
          )}

          {values.when === 'interval' && (
            <IntervalField
              id={id('every-seconds')}
              seconds={values.every_seconds}
              onChange={(n) => set('every_seconds', n)}
              invalid={!!fieldErrors.every_seconds}
              describedBy={id('when-hint')}
            />
          )}

          {values.when === 'once' && (
            <div className="w-full @xl:w-64">
              <DateTimePicker
                id={id('at-datetime')}
                value={values.at_datetime}
                onChange={(v) => set('at_datetime', v)}
                triggerClassName="h-9 rounded-sm text-xs bg-(--bg-page)"
                aria-label="Date and time"
                aria-invalid={!!fieldErrors.at_datetime}
                aria-describedby={id('when-hint')}
              />
            </div>
          )}
        </div>

        {values.when === 'custom' && (
          <div className="mt-3">
            <CronField
              id={id('cron-expression')}
              value={values.cron_expression}
              onChange={(v) => set('cron_expression', v)}
              timezone={timezone}
              error={fieldErrors.cron_expression}
            />
          </div>
        )}

        {timed && (fieldErrors.time
          ? <p id={id('when-hint')} className={FIELD_ERROR}>{fieldErrors.time}</p>
          : nextTimed && (
            <p id={id('when-hint')} className={FIELD_HINT}>
              {runLabel}: <span className="text-(--color-text-2)">{nextTimed}</span> ({timezone}).
            </p>
          ))}
        {values.when === 'interval' && (fieldErrors.every_seconds
          ? <p id={id('when-hint')} className={FIELD_ERROR}>{fieldErrors.every_seconds}</p>
          : (
            <p id={id('when-hint')} className={FIELD_HINT}>
              {nextInterval
                ? <>{runLabel}: <span className="text-(--color-text-2)">{nextInterval}</span>, one interval after you save.</>
                : `${runLabel}: one interval after you save.`}
            </p>
          ))}
        {values.when === 'once' && (fieldErrors.at_datetime
          ? <p id={id('when-hint')} className={FIELD_ERROR}>{fieldErrors.at_datetime}</p>
          : <AtRunHint id={id('when-hint')} value={values.at_datetime} timezone={timezone} />)}
      </div>

      <div>
        <label htmlFor={id('workspace')} className={FIELD_LABEL}>Where?</label>
        <div className="w-full min-w-0 @xl:w-72">
          <Dropdown
            id={id('workspace')}
            value={values.workspace}
            onValueChange={(v) => set('workspace', v)}
            trigger={values.workspace ? workspaceLabel(values.workspace) : 'Choose a workspace…'}
            className={`${DROPDOWN_CLASS} w-full max-w-full`}
            panelClassName="max-w-[min(22rem,calc(100vw-2rem))]"
            aria-invalid={!!fieldErrors.workspace}
            aria-describedby={fieldErrors.workspace ? id('workspace-error') : undefined}
          >
            {workspaces.map((path) => (
              <DropdownItem key={path} value={path}>{workspaceLabel(path)}</DropdownItem>
            ))}
          </Dropdown>
        </div>
        {fieldErrors.workspace && <p id={id('workspace-error')} className={FIELD_ERROR}>{fieldErrors.workspace}</p>}
      </div>

      <div>
        <span className={FIELD_LABEL}>Where does the reply go?</span>
        <SegmentedControl
          label="Where does the reply go?"
          value={values.sessionType}
          onChange={(v) => set('sessionType', v)}
          options={replyOptions}
        />
        <p className={FIELD_HINT}>
          {values.sessionType === 'new' && 'Each run starts its own session.'}
          {values.sessionType === 'auto' && 'Every run adds to one session kept for this task.'}
          {values.sessionType === 'current' && (currentSessionTitle ? `Every run adds to “${currentSessionTitle}”.` : 'Every run adds to the session that is open now.')}
          {values.sessionType === 'custom' && 'Every run adds to the session whose ID is in More options.'}
        </p>
      </div>
    </div>
  )
}
