'use client';

import { useEffect, useState } from 'react';
import { loadKpis } from '@/lib/api';
import type { Loaded } from '@/lib/api';
import type { KpiSnapshot, KpiMetricKey } from '@/lib/types';
import * as fmt from '@/lib/format';

/* -------------------------------------------------------------------------- */
/* Metric definitions (ported from old client/kpi-dashboard.ts)               */
/* -------------------------------------------------------------------------- */

type Direction = 'up-good' | 'down-good' | 'neutral';

interface MetricDef {
  key: KpiMetricKey;
  label: string;
  format: fmt.Formatter;
  /**
   * Defaults to format. Needed where the value formatter already carries a
   * sign (NPS), which would otherwise render a delta as "++9".
   */
  deltaFormat?: fmt.Formatter;
  direction: Direction;
  /** Draws a meter when the metric has a real fixed domain (0..max). */
  meterMax?: number;
  /** Rendered after the value in muted ink, e.g. "/ 5". */
  suffix?: string;
}

interface MetricGroup {
  title: string;
  metrics: MetricDef[];
}

const HERO: MetricDef = {
  key: 'automationRatePct',
  label: 'Automation rate',
  format: fmt.percent,
  direction: 'up-good',
  meterMax: 100,
};

const GROUPS: MetricGroup[] = [
  {
    title: 'Automation',
    metrics: [
      { key: 'ticketDeflectionPct', label: 'Ticket deflection', format: fmt.percent, direction: 'up-good', meterMax: 100 },
      { key: 'escalationRatePct',   label: 'Escalation rate',   format: fmt.percent, direction: 'down-good' },
    ],
  },
  {
    title: 'Volume and speed',
    metrics: [
      { key: 'totalReturns',       label: 'Total returns',  format: fmt.integer, direction: 'neutral' },
      { key: 'returnRatePct',      label: 'Return rate',    format: fmt.percent, direction: 'down-good' },
      { key: 'avgTurnaroundHours', label: 'Avg turnaround', format: fmt.hours,   direction: 'down-good' },
    ],
  },
  {
    title: 'Cost and value',
    metrics: [
      { key: 'retainedRevenueUsd',    label: 'Retained revenue',    format: fmt.currencyCompact, direction: 'up-good' },
      { key: 'avgCostPerReturnUsd',   label: 'Avg cost per return', format: fmt.currency,        direction: 'down-good' },
      { key: 'totalReturnCostUsd',    label: 'Total return cost',   format: fmt.currencyCompact, direction: 'neutral' },
      { key: 'repeatPurchaseRatePct', label: 'Repeat purchase rate', format: fmt.percent,        direction: 'up-good', meterMax: 100 },
    ],
  },
  {
    title: 'Customer experience',
    metrics: [
      { key: 'avgCsat', label: 'Avg CSAT', format: fmt.decimal(1), direction: 'up-good', meterMax: 5, suffix: '/ 5' },
      { key: 'nps',     label: 'NPS',      format: fmt.signedInteger, deltaFormat: fmt.integer, direction: 'up-good' },
    ],
  },
  {
    title: 'Sustainability',
    metrics: [
      { key: 'co2PreventedKg',          label: 'CO2 prevented',           format: fmt.kilograms, direction: 'up-good' },
      { key: 'sustainableReturnPct',    label: 'Sustainable return share', format: fmt.percent,   direction: 'up-good', meterMax: 100 },
      { key: 'packagingWasteAvoidedKg', label: 'Packaging waste avoided',  format: fmt.kilograms, direction: 'up-good' },
    ],
  },
  {
    title: 'Insight loop',
    metrics: [
      { key: 'insightsGenerated', label: 'Insights generated', format: fmt.integer, direction: 'neutral' },
      { key: 'insightsActioned',  label: 'Insights actioned',  format: fmt.integer, direction: 'up-good' },
    ],
  },
];

const ALL_METRICS: MetricDef[] = [HERO, ...GROUPS.flatMap((g) => g.metrics)];

/* -------------------------------------------------------------------------- */
/* Delta helpers                                                               */
/* -------------------------------------------------------------------------- */

type DeltaTone = 'good' | 'bad' | 'flat';

function deltaTone(delta: number, direction: Direction): DeltaTone {
  if (delta === 0 || direction === 'neutral') return 'flat';
  return (direction === 'up-good') === (delta > 0) ? 'good' : 'bad';
}

const TONE_COLOR: Record<DeltaTone, string> = {
  good: 'var(--green)',
  bad:  '#d03b3b',       // no red token in palette; carried over from original
  flat: 'var(--text-muted)',
};

/* -------------------------------------------------------------------------- */
/* Sub-components                                                              */
/* -------------------------------------------------------------------------- */

function ArrowSvg({ up }: { up: boolean }) {
  const d = up ? 'M6 2.5 L10 8.5 L2 8.5 Z' : 'M6 9.5 L10 3.5 L2 3.5 Z';
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"
      style={{ flex: 'none', display: 'block' }}>
      <path d={d} fill="currentColor" />
    </svg>
  );
}

function DeltaRow({ def, snapshot, large = false }: {
  def: MetricDef;
  snapshot: KpiSnapshot;
  large?: boolean;
}) {
  const delta = (snapshot.deltas as Record<string, number | undefined>)[def.key];
  if (delta === undefined) {
    return (
      <p style={{ margin: '8px 0 0', fontSize: large ? '13px' : '12px', color: 'var(--text-muted)' }}>
        No prior-period comparison
      </p>
    );
  }
  const tone = deltaTone(delta, def.direction);
  const text = fmt.formatDelta(delta, def.deltaFormat ?? def.format);
  return (
    <p style={{
      margin: '8px 0 0',
      fontSize: large ? '13px' : '12px',
      display: 'flex',
      flexWrap: 'wrap',
      gap: '5px',
      alignItems: 'center',
      color: TONE_COLOR[tone],
    }}>
      {delta !== 0 && <ArrowSvg up={delta > 0} />}
      <span style={{ fontWeight: 600 }}>{text}</span>
      <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
        vs prior {snapshot.windowDays}d
      </span>
    </p>
  );
}

function MeterBar({ value, max, ariaLabel }: { value: number; max: number; ariaLabel: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      role="img"
      aria-label={ariaLabel}
      style={{
        overflow: 'hidden',
        height: '5px',
        borderRadius: '4px',
        marginTop: '10px',
        background: 'var(--border)',   // matches card border token throughout the app
      }}
    >
      <span style={{
        display: 'block',
        height: '100%',
        width: `${pct.toFixed(1)}%`,
        borderRadius: '0 4px 4px 0',
        background: 'var(--purple-light)',
        transition: 'width 240ms ease-out',
      }} />
    </div>
  );
}

function Tile({ def, snapshot }: { def: MetricDef; snapshot: KpiSnapshot }) {
  const value = snapshot[def.key] as number;
  return (
    <article className="card" style={{ padding: '16px 18px' }}>
      <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-muted)', fontWeight: 500 }}>
        {def.label}
      </p>
      <p style={{
        margin: '6px 0 0',
        fontSize: '26px',
        fontWeight: 600,
        letterSpacing: '-0.01em',
        lineHeight: 1.15,
        color: 'var(--text)',
      }}>
        {def.format(value)}
        {def.suffix && (
          <span style={{ marginLeft: '5px', fontSize: '14px', fontWeight: 400, color: 'var(--text-muted)' }}>
            {def.suffix}
          </span>
        )}
      </p>
      {def.meterMax !== undefined && (
        <MeterBar
          value={value}
          max={def.meterMax}
          ariaLabel={`${def.label}: ${def.format(value)} of ${def.format(def.meterMax)}`}
        />
      )}
      <DeltaRow def={def} snapshot={snapshot} />
    </article>
  );
}

function HeroSection({ snapshot }: { snapshot: KpiSnapshot }) {
  const value = snapshot[HERO.key] as number;
  return (
    <>
      <style>{`
        @media (max-width: 720px) {
          #kpi-hero { grid-template-columns: minmax(0,1fr) !important; }
          #kpi-hero-caption { display: none; }
        }
      `}</style>
      <section
        id="kpi-hero"
        className="card"
        aria-labelledby="kpi-hero-label"
        style={{
          padding: '24px 28px',
          marginBottom: '28px',
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
          columnGap: '40px',
          alignItems: 'center',
        }}
      >
        <div>
          <p id="kpi-hero-label" style={{ margin: 0, fontSize: '13px', fontWeight: 500, color: 'var(--text-muted)' }}>
            {HERO.label}
          </p>
          <p style={{
            margin: '4px 0 0',
            fontSize: '52px',
            fontWeight: 700,
            letterSpacing: '-0.02em',
            lineHeight: 1.05,
            color: 'var(--text)',
          }}>
            {HERO.format(value)}
          </p>
          <MeterBar
            value={value}
            max={100}
            ariaLabel={`Automation rate: ${HERO.format(value)} of 100%`}
          />
          <DeltaRow def={HERO} snapshot={snapshot} large />
        </div>
        <p id="kpi-hero-caption" style={{
          margin: 0,
          maxWidth: '46ch',
          fontSize: '13px',
          color: 'var(--text-muted)',
          lineHeight: 1.6,
        }}>
          Share of returns closed end to end with no human touch, over the
          last {snapshot.windowDays} days.
        </p>
      </section>
    </>
  );
}

function MetricGroupSection({ group, snapshot }: { group: MetricGroup; snapshot: KpiSnapshot }) {
  const id = `kpi-group-${group.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <section aria-labelledby={id} style={{ marginBottom: '24px' }}>
      <h2 id={id} style={{
        margin: '0 0 12px',
        paddingBottom: '8px',
        borderBottom: '1px solid var(--border)',
        fontSize: '11px',
        fontWeight: 600,
        letterSpacing: '0.07em',
        textTransform: 'uppercase',
        color: 'var(--text-muted)',
      }}>
        {group.title}
      </h2>
      <div style={{
        display: 'grid',
        gap: '12px',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
      }}>
        {group.metrics.map((def) => (
          <Tile key={def.key} def={def} snapshot={snapshot} />
        ))}
      </div>
    </section>
  );
}

function KpiTable({ snapshot }: { snapshot: KpiSnapshot }) {
  return (
    <div style={{ borderRadius: '12px', overflow: 'hidden', border: '1px solid var(--border)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', background: 'var(--bg-card)' }}>
        <caption style={{
          padding: '10px 16px',
          color: 'var(--text-muted)',
          fontSize: '13px',
          textAlign: 'left',
          captionSide: 'top',
        }}>
          All executive KPIs for the last {snapshot.windowDays} days.
        </caption>
        <thead>
          <tr>
            {(['Metric', 'Value', 'Change'] as const).map((h, i) => (
              <th key={h} scope="col" style={{
                padding: '10px 16px',
                borderBottom: '1px solid var(--border)',
                textAlign: i === 0 ? 'left' : 'right',
                fontSize: '11px',
                fontWeight: 600,
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
                color: 'var(--text-muted)',
              }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ALL_METRICS.map((def, i) => {
            const value = snapshot[def.key] as number;
            const delta = (snapshot.deltas as Record<string, number | undefined>)[def.key];
            const tone = delta !== undefined ? deltaTone(delta, def.direction) : 'flat';
            const isLast = i === ALL_METRICS.length - 1;
            const cell = {
              padding: '10px 16px',
              borderBottom: isLast ? 'none' : '1px solid var(--border)',
            };
            return (
              <tr key={def.key}>
                <th scope="row" style={{ ...cell, textAlign: 'left', fontWeight: 500, color: 'var(--text)' }}>
                  {def.label}
                </th>
                <td style={{ ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text)' }}>
                  {def.format(value)}
                </td>
                <td style={{
                  ...cell,
                  textAlign: 'right',
                  fontVariantNumeric: 'tabular-nums',
                  color: delta !== undefined ? TONE_COLOR[tone] : 'var(--text-muted)',
                }}>
                  {delta !== undefined ? fmt.formatDelta(delta, def.deltaFormat ?? def.format) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SourceBadge({ loaded }: { loaded: Loaded<KpiSnapshot> }) {
  const isLive = loaded.source === 'live';
  return (
    <span
      title={loaded.reason ?? undefined}
      style={{ display: 'inline-flex', gap: '6px', alignItems: 'center', fontSize: '12px', color: 'var(--text-muted)' }}
    >
      <span aria-hidden="true" style={{
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        flexShrink: 0,
        background: isLive ? 'var(--green)' : '#fab219',  // no yellow token; carried from original
      }} />
      {isLive ? 'Live backend' : 'Sample data — backend unreachable'}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

export default function KpiPage() {
  const [loaded, setLoaded]         = useState<Loaded<KpiSnapshot> | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showTable, setShowTable]   = useState(false);

  useEffect(() => {
    let active = true;
    loadKpis().then((result) => { if (active) setLoaded(result); });
    return () => { active = false; };
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    setLoaded(await loadKpis());
    setRefreshing(false);
  };

  const snapshot = loaded?.data ?? null;

  const btnBase = {
    padding: '7px 14px',
    borderRadius: '8px',
    fontSize: '13px',
    fontFamily: 'inherit',
    cursor: 'pointer' as const,
    transition: 'border-color 120ms',
  };

  return (
    <div style={{
      maxWidth: '1180px',
      margin: '0 auto',
      padding: '32px clamp(16px,4vw,48px) 64px',
      position: 'relative',
      zIndex: 1,
    }}>

      {/* Header */}
      <header style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '16px',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        marginBottom: '28px',
      }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '22px', fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--text)' }}>
            Executive KPI dashboard
          </h1>
          {loaded && (
            <p style={{
              margin: '6px 0 0',
              fontSize: '13px',
              color: 'var(--text-muted)',
              display: 'flex',
              flexWrap: 'wrap',
              gap: '8px',
              alignItems: 'center',
            }}>
              Last {loaded.data.windowDays} days · generated {fmt.formatTimestamp(loaded.data.generatedAt)}
              <SourceBadge loaded={loaded} />
            </p>
          )}
        </div>

        {/* Controls: table toggle | theme toggle | refresh — same order as original */}
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            onClick={() => setShowTable((v) => !v)}
            aria-pressed={showTable}
            style={{
              ...btnBase,
              border: `1px solid ${showTable ? 'var(--border-hover)' : 'var(--border)'}`,
              background: showTable ? 'var(--purple-pale)' : 'rgba(255,255,255,0.04)',
              color: showTable ? 'var(--purple-light)' : 'var(--text)',
            }}
          >
            {showTable ? 'Tile view' : 'Table view'}
          </button>
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            style={{
              ...btnBase,
              border: '1px solid var(--border)',
              background: 'rgba(255,255,255,0.04)',
              color: 'var(--text)',
              fontWeight: 600,
              opacity: refreshing ? 0.55 : 1,
              cursor: refreshing ? 'default' : 'pointer',
            }}
          >
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </header>

      {/* Body — held at reduced opacity while a refetch is in flight */}
      <div style={{ opacity: refreshing && snapshot ? 0.6 : 1, transition: 'opacity 120ms ease-out' }}>
        {!snapshot ? (
          <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Loading...</p>
        ) : showTable ? (
          <KpiTable snapshot={snapshot} />
        ) : (
          <>
            <HeroSection snapshot={snapshot} />
            {GROUPS.map((group) => (
              <MetricGroupSection key={group.title} group={group} snapshot={snapshot} />
            ))}
          </>
        )}
      </div>

    </div>
  );
}
