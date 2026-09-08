/**
 * EXECUTIVE KPI DASHBOARD  (PRD persona "Finley")
 * Data source: GET /api/v1/analytics/kpis -> KpiSnapshot
 *
 * This is a figures view, not a chart view: the snapshot has no series, so the
 * right form is one hero figure plus stat tiles. Trend series live at
 * /analytics/trends and belong to whoever builds the trends page.
 */
import type { KpiMetricKey, KpiSnapshot } from './types.js';
import { loadKpis, type DataSource } from './api.js';
import * as fmt from './format.js';

/* -------------------------------------------------------------------------- */
/* Metric definitions                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Which way is good. This is the single most load-bearing field on the page:
 * a falling cost and a falling CSAT are both negative numbers but opposite
 * news, so delta colour is direction x sign, never sign alone.
 */
type Direction = 'up-good' | 'down-good' | 'neutral';

interface MetricDef {
  key: KpiMetricKey;
  label: string;
  format: fmt.Formatter;
  /**
   * Defaults to `format`. Needed where the value formatter already carries a
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

/**
 * Exactly one hero per view. Automation rate over retained revenue: it is the
 * metric this whole pipeline exists to move, and it is one of the nine keys the
 * backend actually populates a delta for, so the headline carries a trend.
 */
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
      { key: 'escalationRatePct', label: 'Escalation rate', format: fmt.percent, direction: 'down-good' },
    ],
  },
  {
    title: 'Volume and speed',
    metrics: [
      { key: 'totalReturns', label: 'Total returns', format: fmt.integer, direction: 'neutral' },
      { key: 'returnRatePct', label: 'Return rate', format: fmt.percent, direction: 'down-good' },
      { key: 'avgTurnaroundHours', label: 'Avg turnaround', format: fmt.hours, direction: 'down-good' },
    ],
  },
  {
    title: 'Cost and value',
    metrics: [
      { key: 'retainedRevenueUsd', label: 'Retained revenue', format: fmt.currencyCompact, direction: 'up-good' },
      { key: 'avgCostPerReturnUsd', label: 'Avg cost per return', format: fmt.currency, direction: 'down-good' },
      { key: 'totalReturnCostUsd', label: 'Total return cost', format: fmt.currencyCompact, direction: 'neutral' },
      { key: 'repeatPurchaseRatePct', label: 'Repeat purchase rate', format: fmt.percent, direction: 'up-good', meterMax: 100 },
    ],
  },
  {
    title: 'Customer experience',
    metrics: [
      { key: 'avgCsat', label: 'Avg CSAT', format: fmt.decimal(1), direction: 'up-good', meterMax: 5, suffix: '/ 5' },
      { key: 'nps', label: 'NPS', format: fmt.signedInteger, deltaFormat: fmt.integer, direction: 'up-good' },
    ],
  },
  {
    title: 'Sustainability',
    metrics: [
      { key: 'co2PreventedKg', label: 'CO2 prevented', format: fmt.kilograms, direction: 'up-good' },
      { key: 'sustainableReturnPct', label: 'Sustainable return share', format: fmt.percent, direction: 'up-good', meterMax: 100 },
      { key: 'packagingWasteAvoidedKg', label: 'Packaging waste avoided', format: fmt.kilograms, direction: 'up-good' },
    ],
  },
  {
    title: 'Insight loop',
    metrics: [
      { key: 'insightsGenerated', label: 'Insights generated', format: fmt.integer, direction: 'neutral' },
      { key: 'insightsActioned', label: 'Insights actioned', format: fmt.integer, direction: 'up-good' },
    ],
  },
];

const ALL_METRICS: MetricDef[] = [HERO, ...GROUPS.flatMap((g) => g.metrics)];

/* -------------------------------------------------------------------------- */
/* Rendering helpers                                                          */
/* -------------------------------------------------------------------------- */

const esc = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** HTML ids may not contain whitespace. */
const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '-');

type DeltaTone = 'good' | 'bad' | 'flat';

function deltaTone(delta: number, direction: Direction): DeltaTone {
  if (delta === 0 || direction === 'neutral') return 'flat';
  const isUp = delta > 0;
  return (direction === 'up-good') === isUp ? 'good' : 'bad';
}

/**
 * SVG rather than a unicode triangle: this repo ships a fix-mojibake script,
 * so encoding-sensitive glyphs are avoided in source.
 */
function arrowSvg(up: boolean): string {
  const d = up ? 'M6 2.5 L10 8.5 L2 8.5 Z' : 'M6 9.5 L10 3.5 L2 3.5 Z';
  return `<svg class="delta__arrow" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="${d}" fill="currentColor"/></svg>`;
}

/**
 * Direction is carried by the arrow AND the explicit sign AND the "vs prior"
 * label, so colour is never the only channel.
 */
function renderDelta(def: MetricDef, snapshot: KpiSnapshot): string {
  const delta = snapshot.deltas[def.key];
  if (delta === undefined) {
    return `<p class="delta delta--absent">No prior-period comparison</p>`;
  }
  const tone = deltaTone(delta, def.direction);
  const text = fmt.formatDelta(delta, def.deltaFormat ?? def.format);
  const icon = delta === 0 ? '' : arrowSvg(delta > 0);
  return `<p class="delta delta--${tone}">${icon}<span class="delta__value">${esc(text)}</span><span class="delta__period">vs prior ${snapshot.windowDays}d</span></p>`;
}

function renderMeter(def: MetricDef, value: number): string {
  if (def.meterMax === undefined) return '';
  const pct = Math.max(0, Math.min(100, (value / def.meterMax) * 100));
  return `<div class="meter" role="img" aria-label="${esc(def.format(value))} of ${esc(def.format(def.meterMax))}"><span class="meter__fill" style="width:${pct.toFixed(1)}%"></span></div>`;
}

function renderTile(def: MetricDef, snapshot: KpiSnapshot): string {
  const value = snapshot[def.key];
  const suffix = def.suffix ? `<span class="tile__suffix">${esc(def.suffix)}</span>` : '';
  return `
    <article class="tile">
      <h3 class="tile__label">${esc(def.label)}</h3>
      <p class="tile__value">${esc(def.format(value))}${suffix}</p>
      ${renderMeter(def, value)}
      ${renderDelta(def, snapshot)}
    </article>`;
}

function renderHero(snapshot: KpiSnapshot): string {
  return `
    <section class="hero" aria-labelledby="hero-label">
      <h2 class="hero__label" id="hero-label">${esc(HERO.label)}</h2>
      <p class="hero__value">${esc(HERO.format(snapshot[HERO.key]))}</p>
      ${renderMeter(HERO, snapshot[HERO.key])}
      ${renderDelta(HERO, snapshot)}
      <p class="hero__caption">Share of returns closed end to end with no human touch, over the last ${snapshot.windowDays} days.</p>
    </section>`;
}

function renderGroup(group: MetricGroup, snapshot: KpiSnapshot): string {
  return `
    <section class="group" aria-labelledby="group-${slug(group.title)}">
      <h2 class="group__title" id="group-${slug(group.title)}">${esc(group.title)}</h2>
      <div class="group__tiles">${group.metrics.map((m) => renderTile(m, snapshot)).join('')}</div>
    </section>`;
}

/** Accessibility requirement: every figure on the page is also reachable as text. */
function renderTable(snapshot: KpiSnapshot): string {
  const rows = ALL_METRICS.map((def) => {
    const delta = snapshot.deltas[def.key];
    const deltaCell =
      delta === undefined
        ? '<td class="num muted">&mdash;</td>'
        : `<td class="num delta--${deltaTone(delta, def.direction)}">${esc(fmt.formatDelta(delta, def.deltaFormat ?? def.format))}</td>`;
    return `<tr><th scope="row">${esc(def.label)}</th><td class="num">${esc(def.format(snapshot[def.key]))}</td>${deltaCell}</tr>`;
  }).join('');

  return `
    <table class="kpi-table">
      <caption>All executive KPIs for the last ${snapshot.windowDays} days.</caption>
      <thead><tr><th scope="col">Metric</th><th scope="col" class="num">Value</th><th scope="col" class="num">Change</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderSourceBadge(source: DataSource, reason: string | null): string {
  if (source === 'live') return `<span class="badge badge--live">Live backend</span>`;
  return `<span class="badge badge--mock" title="${esc(reason ?? '')}">Sample data - backend unreachable</span>`;
}

/* -------------------------------------------------------------------------- */
/* Mount                                                                      */
/* -------------------------------------------------------------------------- */

export function mountKpiDashboard(root: HTMLElement): void {
  root.innerHTML = `
    <header class="page-head">
      <div>
        <h1 class="page-title">Executive KPI dashboard</h1>
        <p class="page-sub" data-role="subtitle">Loading...</p>
      </div>
      <div class="page-actions">
        <button type="button" class="btn" data-role="table-toggle" aria-pressed="false">Table view</button>
        <button type="button" class="btn" data-role="theme-toggle">Dark mode</button>
        <button type="button" class="btn btn--primary" data-role="refresh">Refresh</button>
      </div>
    </header>
    <div class="page-body" data-role="body"></div>`;

  const body = root.querySelector<HTMLElement>('[data-role="body"]')!;
  const subtitle = root.querySelector<HTMLElement>('[data-role="subtitle"]')!;
  const refreshBtn = root.querySelector<HTMLButtonElement>('[data-role="refresh"]')!;
  const tableBtn = root.querySelector<HTMLButtonElement>('[data-role="table-toggle"]')!;
  const themeBtn = root.querySelector<HTMLButtonElement>('[data-role="theme-toggle"]')!;

  let snapshot: KpiSnapshot | null = null;
  let showTable = false;

  const paint = (): void => {
    if (!snapshot) return;
    body.innerHTML = showTable
      ? renderTable(snapshot)
      : renderHero(snapshot) + GROUPS.map((g) => renderGroup(g, snapshot!)).join('');
  };

  const refresh = async (): Promise<void> => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Refreshing...';
    // Hold the previous render at reduced opacity instead of blanking it, so a
    // refetch never causes a layout jump.
    body.classList.add('page-body--loading');
    const loaded = await loadKpis();
    snapshot = loaded.data;
    subtitle.innerHTML = `Last ${loaded.data.windowDays} days &middot; generated ${esc(
      fmt.formatTimestamp(loaded.data.generatedAt),
    )} ${renderSourceBadge(loaded.source, loaded.reason)}`;
    paint();
    body.classList.remove('page-body--loading');
    refreshBtn.disabled = false;
    refreshBtn.textContent = 'Refresh';
  };

  tableBtn.addEventListener('click', () => {
    showTable = !showTable;
    tableBtn.setAttribute('aria-pressed', String(showTable));
    tableBtn.textContent = showTable ? 'Tile view' : 'Table view';
    paint();
  });

  themeBtn.addEventListener('click', () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
    themeBtn.textContent = dark ? 'Dark mode' : 'Light mode';
  });

  refreshBtn.addEventListener('click', () => void refresh());
  void refresh();
}
