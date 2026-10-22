import type { ReactNode } from 'react'
import { Clock } from 'lucide-react'
import { clampPercent } from './usage'
import type { MeterRow, ProviderView, Row } from './providerView'

/**
 * One provider. Several limits get a card with the provider's name over
 * rows named by limit; a single limit is one row that names the provider;
 * a balance or a status is one line.
 */
export function ProviderCard({ view, onManage }: { view: ProviderView; onManage: () => void }) {
  const tone = view.reached ? 'crit' : view.tone
  const stale = view.stale ? <StaleMark /> : null

  if (view.status) {
    return (
      <section className="card" role="group" aria-label={view.name}>
        <div className="line">
          <span className="line-name">{view.name}</span>
          {view.status === 'reconnect' ? (
            <button type="button" className="small-btn" onClick={onManage} aria-label={`Reconnect ${view.name}`} title="Opens Settings → Providers">
              Reconnect
            </button>
          ) : (
            <span className="line-muted">{view.status === 'unavailable' ? 'Unavailable' : 'No usage data'}</span>
          )}
        </div>
      </section>
    )
  }

  const [only] = view.rows
  if (view.rows.length === 1 && only.kind === 'value') {
    return (
      <section className="card" role="group" aria-label={view.name} data-tone={tone}>
        <div className="line">
          <span className="line-name">{view.name}</span>
          <span className="line-end">
            {stale}
            <span className="line-muted">{only.label}</span>
            <span className="line-value" data-tone={only.tone}>{only.value}</span>
          </span>
        </div>
      </section>
    )
  }

  if (view.rows.length === 1 && only.kind === 'meter') {
    return (
      <section className="card" role="group" aria-label={view.name} data-tone={tone}>
        <Meter row={only} owner={view.name} named stale={stale} />
      </section>
    )
  }

  return (
    <section className="card" role="group" aria-label={view.name} data-tone={tone}>
      <header className="card-head">
        <span className="card-name">{view.name}</span>
        <span className="card-meta">
          {stale}
          {tone === 'crit' && <span className="card-alert">{view.reached ? 'Limit reached' : 'Near limit'}</span>}
          {view.plan && <span>{view.plan}</span>}
        </span>
      </header>
      {view.rows.map((row) => <RowView key={row.key} row={row} owner={view.name} />)}
    </section>
  )
}

function RowView({ row, owner }: { row: Row; owner: string }) {
  if (row.kind === 'meter') return <Meter row={row} owner={owner} />
  return (
    <div className="row">
      <div className="row-top">
        <span className="row-label">{row.label}</span>
        <span className="line-value" data-tone={row.tone}>{row.value}</span>
      </div>
    </div>
  )
}

/**
 * A limit's bar. The fill is usage consumed; the tick is how much of the
 * quota window has gone, so a fill well past the tick is ahead of pace.
 */
function Meter({ row, owner, named = false, stale = null }: {
  row: MeterRow
  owner: string
  /** The row stands for the whole provider, so it carries the name. */
  named?: boolean
  stale?: ReactNode
}) {
  const percent = Math.round(row.percent)
  const tone = row.reached ? 'crit' : row.tone
  const pace = row.nowLine === null ? '' : ` · ${Math.round(row.nowLine)}% of the window gone`
  return (
    <div className="row">
      <div className="row-top">
        <span className="row-label">
          {named ? (
            <>
              <span className="row-owner">{owner}</span>
              <span className="row-window">{row.label}</span>
            </>
          ) : row.label}
          {stale}
        </span>
        <span className="row-figures">
          <span className="row-percent" data-tone={tone}>{percent}%</span>
          {row.reset && <span> · {row.reset}</span>}
        </span>
      </div>
      <div
        className="meter"
        role="meter"
        aria-label={`${owner} ${row.label}`}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${percent}% used${row.reset ? `, ${row.reset.toLowerCase()}` : ''}`}
        title={`${percent}% used${pace}`}
      >
        <div className="meter-clip">
          <div className="meter-fill" data-tone={tone} style={{ transform: `scaleX(${clampPercent(row.percent) / 100})` }} />
        </div>
        {row.nowLine !== null && <div className="meter-now" style={{ left: `${row.nowLine}%` }} />}
      </div>
      {row.detail && <p className="row-detail">{row.detail}</p>}
    </div>
  )
}

function StaleMark() {
  return (
    <span className="stale" title="The last refresh failed for this provider; this is the last value seen">
      <Clock size={11} strokeWidth={2} aria-hidden="true" />
      Last known
    </span>
  )
}

/** Placeholder cards in the shape of a two-limit and a one-limit provider. */
export function ProviderSkeleton() {
  return (
    <div className="list skeleton" aria-label="Loading usage" aria-busy="true">
      {[2, 1].map((rows, card) => (
        <div key={card} className="card" aria-hidden="true">
          {rows > 1 && (
            <div className="card-head">
              <span className="sk" style={{ width: 84 }} />
              <span className="sk" style={{ width: 28 }} />
            </div>
          )}
          {Array.from({ length: rows }, (_, row) => (
            <div key={row} className="row">
              <div className="row-top">
                <span className="sk" style={{ width: rows > 1 ? 48 : 96 }} />
                <span className="sk" style={{ width: 96 }} />
              </div>
              <div className="meter" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
