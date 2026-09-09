/**
 * Value formatters. ASCII-only output on purpose — this repo has a
 * scripts/fix-mojibake.mjs, so glyphs like the minus sign and CO2 subscript are
 * avoided; arrows are drawn as SVG in the dashboard rather than typed as text.
 */

const nf = (min: number, max: number) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max });

export type Formatter = (value: number) => string;

export const integer: Formatter = (v) => nf(0, 0).format(v);

export const decimal = (places: number): Formatter => (v) => nf(places, places).format(v);

export const percent: Formatter = (v) => `${nf(0, 1).format(v)}%`;

export const currency: Formatter = (v) => `$${nf(2, 2).format(v)}`;

/** Compact for headline figures: $842 / $12.9K / $4.2M. */
export const currencyCompact: Formatter = (v) => {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${nf(0, 1).format(v / 1_000_000)}M`;
  if (abs >= 10_000) return `$${nf(0, 1).format(v / 1_000)}K`;
  return `$${nf(0, 0).format(v)}`;
};

export const hours: Formatter = (v) => `${nf(0, 1).format(v)}h`;

export const kilograms: Formatter = (v) => `${nf(0, 1).format(v)} kg`;

/** NPS is conventionally shown signed. */
export const signedInteger: Formatter = (v) => `${v > 0 ? '+' : ''}${nf(0, 0).format(v)}`;

/**
 * Delta text. Always signed so the direction is readable without the arrow —
 * the arrow is a redundant channel, never the only one.
 */
export function formatDelta(value: number, format: Formatter): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${format(Math.abs(value))}`;
}

/** "8 Sep 2026, 10:15" — short enough for a tile footer. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
