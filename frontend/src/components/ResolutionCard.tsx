'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Package, Leaf, Copy, Check } from 'lucide-react';
import type { ReturnResponse } from '@/lib/types';

interface Props {
  result: ReturnResponse;
  onStartAnother?: () => void;
}

const RESOLUTION_LABELS: Record<string, string> = {
  refund: 'Full Refund',
  exchange: 'Exchange',
  store_credit: 'Store Credit',
  repair: 'Repair',
  escalated: 'Escalated',
};

export default function ResolutionCard({ result, onStartAnother }: Props) {
  const [copied, setCopied] = useState(false);

  function copyTracking() {
    if (!result.trackingNumber) return;
    navigator.clipboard.writeText(result.trackingNumber).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const resolutionLabel =
    (result.resolution && RESOLUTION_LABELS[result.resolution]) ?? 'Resolution';

  return (
    <div
      className="fade-in"
      style={{ maxWidth: '640px', margin: '0 auto' }}
    >
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ textAlign: 'center', marginBottom: '32px' }}>
        <div
          style={{
            width: '64px',
            height: '64px',
            borderRadius: '50%',
            background: 'rgba(16, 185, 129, 0.12)',
            border: '2px solid rgba(16, 185, 129, 0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 16px',
          }}
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 28 28"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M5 14l6 6L23 8"
              stroke="#10b981"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <h1
          style={{
            fontSize: '28px',
            fontWeight: 700,
            color: 'var(--text)',
            marginBottom: '8px',
          }}
        >
          Return approved!
        </h1>
        {result.resolutionDetail && (
          <p
            style={{
              color: 'var(--text-muted)',
              fontSize: '15px',
              maxWidth: '420px',
              margin: '0 auto',
              lineHeight: 1.6,
            }}
          >
            {result.resolutionDetail}
          </p>
        )}
      </div>

      {/* ── Metric row ─────────────────────────────────────────────────────── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
          gap: '12px',
          marginBottom: '24px',
        }}
      >
        {/* Resolution type — always shown */}
        <div
          className="card"
          style={{
            padding: '16px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <Package size={18} color="var(--purple-light)" aria-hidden="true" />
          <div
            style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text)' }}
          >
            {resolutionLabel}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Resolution type
          </div>
        </div>

        {/* Refund amount */}
        {result.estimatedRefund !== undefined && (
          <div
            className="card"
            style={{
              padding: '16px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <span style={{ fontSize: '18px', lineHeight: 1 }} aria-hidden="true">
              💳
            </span>
            <div
              style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text)' }}
            >
              ${result.estimatedRefund.toFixed(2)}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Refund amount
            </div>
          </div>
        )}

        {/* Bonus points */}
        {result.bonusPoints !== undefined && (
          <div
            className="card"
            style={{
              padding: '16px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <span style={{ fontSize: '18px', lineHeight: 1 }} aria-hidden="true">
              ⭐
            </span>
            <div
              style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text)' }}
            >
              +{result.bonusPoints}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Rewards points
            </div>
          </div>
        )}

        {/* CO2 saved */}
        {result.co2Saved !== undefined && (
          <div
            className="card"
            style={{
              padding: '16px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <Leaf size={18} color="#10b981" aria-hidden="true" />
            <div
              style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text)' }}
            >
              {result.co2Saved} kg
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              CO&#8322; saved
            </div>
          </div>
        )}
      </div>

      {/* ── Next steps ─────────────────────────────────────────────────────── */}
      {result.nextSteps && result.nextSteps.length > 0 && (
        <div className="card" style={{ padding: '24px 28px', marginBottom: '16px' }}>
          <h3
            style={{
              fontSize: '15px',
              fontWeight: 600,
              color: 'var(--text)',
              marginBottom: '16px',
            }}
          >
            Next steps
          </h3>
          <ol
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            {result.nextSteps.map((step, i) => (
              <li
                key={i}
                style={{
                  display: 'flex',
                  gap: '12px',
                  alignItems: 'flex-start',
                }}
              >
                <span
                  style={{
                    width: '22px',
                    height: '22px',
                    borderRadius: '50%',
                    background: 'var(--purple-pale)',
                    border: '1px solid var(--border)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '11px',
                    fontWeight: 700,
                    color: 'var(--purple-light)',
                    flexShrink: 0,
                    marginTop: '1px',
                  }}
                  aria-hidden="true"
                >
                  {i + 1}
                </span>
                <span
                  style={{
                    fontSize: '14px',
                    color: 'var(--text)',
                    lineHeight: 1.5,
                  }}
                >
                  {step}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* ── Tracking number ─────────────────────────────────────────────────── */}
      {result.trackingNumber && (
        <div
          className="card"
          style={{ padding: '16px 20px', marginBottom: '16px' }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
            }}
          >
            <div>
              <div
                style={{
                  fontSize: '12px',
                  color: 'var(--text-muted)',
                  marginBottom: '4px',
                }}
              >
                Tracking number
              </div>
              <code
                style={{
                  fontFamily: 'monospace',
                  fontSize: '14px',
                  color: 'var(--purple-light)',
                  letterSpacing: '0.05em',
                }}
              >
                {result.trackingNumber}
              </code>
            </div>
            <button
              onClick={copyTracking}
              style={{
                background: 'rgba(124, 58, 237, 0.1)',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                padding: '6px 12px',
                cursor: 'pointer',
                color: 'var(--purple-light)',
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                fontSize: '13px',
                transition: 'all 0.15s',
                flexShrink: 0,
                fontFamily: 'inherit',
              }}
              aria-label="Copy tracking number"
            >
              {copied ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <Copy size={14} aria-hidden="true" />
              )}
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {/* ── Pickup date ─────────────────────────────────────────────────────── */}
      {result.pickupDate && (
        <div
          style={{
            padding: '12px 16px',
            background: 'rgba(16, 185, 129, 0.06)',
            border: '1px solid rgba(16, 185, 129, 0.2)',
            borderRadius: '8px',
            fontSize: '14px',
            color: 'var(--text)',
            marginBottom: '16px',
          }}
        >
          Pickup scheduled:{' '}
          <strong>{result.pickupDate}</strong>
        </div>
      )}

      {/* ── Return ID ────────────────────────────────────────────────────────── */}
      <div style={{ textAlign: 'center', marginBottom: '28px' }}>
        <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
          Return ID:{' '}
          <code
            style={{
              fontFamily: 'monospace',
              color: 'var(--purple-light)',
            }}
          >
            {result.returnId}
          </code>
        </span>
      </div>

      {/* ── Action buttons ───────────────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          gap: '12px',
          justifyContent: 'center',
          flexWrap: 'wrap',
        }}
      >
        <Link href="/" className="btn-secondary">
          Done
        </Link>
        {onStartAnother ? (
          <button className="btn-primary" onClick={onStartAnother}>
            Start another return
          </button>
        ) : (
          <Link href="/return" className="btn-primary">
            Start another return
          </Link>
        )}
      </div>
    </div>
  );
}
