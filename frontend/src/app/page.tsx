'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Clock, Package, Zap, RotateCcw, Star, CheckCircle, XCircle, AlertCircle, ArrowLeft, Leaf, Copy, Check } from 'lucide-react';
import { getUser, getStoredReturns, type AuthUser, type StoredReturn } from '@/lib/auth';

const STATUS_CONFIG: Record<string, { color: string; bg: string; border: string; Icon: React.ElementType }> = {
  approved:  { color: '#10b981', bg: 'rgba(16,185,129,0.08)',  border: 'rgba(16,185,129,0.2)',  Icon: CheckCircle },
  denied:    { color: '#f87171', bg: 'rgba(239,68,68,0.08)',   border: 'rgba(239,68,68,0.2)',   Icon: XCircle },
  escalated: { color: '#fbbf24', bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.2)',  Icon: AlertCircle },
  processing:{ color: 'var(--purple-light)', bg: 'var(--purple-pale)', border: 'var(--border)', Icon: Clock },
};

const RESOLUTION_LABELS: Record<string, string> = {
  refund: 'Full Refund', exchange: 'Exchange', store_credit: 'Store Credit',
  repair: 'Repair', escalated: 'Escalated',
};

function statusLabel(ret: StoredReturn): string {
  const res = ret.resolution ? (RESOLUTION_LABELS[ret.resolution] ?? ret.resolution) : 'Return';
  if (ret.status === 'approved')  return `${res} approved`;
  if (ret.status === 'denied')    return 'Denied';
  if (ret.status === 'escalated') return 'Under review';
  return `${res} pending`;
}

function Metric({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', borderRadius: '10px', padding: '14px 18px', minWidth: '110px' }}>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      {mono
        ? <code style={{ fontSize: '13px', color: 'var(--purple-light)', fontFamily: 'monospace' }}>{value}</code>
        : <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text)' }}>{value}</div>}
    </div>
  );
}

function ReturnDetail({ ret, onBack }: { ret: StoredReturn; onBack: () => void }) {
  const cfg = STATUS_CONFIG[ret.status] ?? STATUS_CONFIG.processing;
  const { Icon } = cfg;
  const [copied, setCopied] = useState(false);
  const submitted = new Date(ret.submittedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  function copyTracking() {
    if (!ret.trackingNumber) return;
    navigator.clipboard.writeText(ret.trackingNumber).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="fade-in" style={{ maxWidth: '680px', margin: '0 auto', padding: '40px 24px', position: 'relative', zIndex: 1 }}>
      <button
        onClick={onBack}
        style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '14px', marginBottom: '32px', padding: 0 }}
      >
        <ArrowLeft size={15} aria-hidden="true" /> Back to returns
      </button>

      {/* Status header */}
      <div style={{ textAlign: 'center', marginBottom: '32px' }}>
        <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: cfg.bg, border: `2px solid ${cfg.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
          <Icon size={28} color={cfg.color} aria-hidden="true" />
        </div>
        <h1 style={{ fontSize: '26px', fontWeight: 700, color: 'var(--text)', marginBottom: '6px' }}>
          {statusLabel(ret)}
        </h1>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
          {ret.productNames.join(' · ')} · {ret.orderId} · {submitted}
        </p>
      </div>

      {/* Resolution detail */}
      {ret.resolutionDetail && (
        <div className="card" style={{ padding: '20px 24px', marginBottom: '16px' }}>
          <p style={{ fontSize: '15px', color: 'var(--text)', lineHeight: 1.7 }}>{ret.resolutionDetail}</p>
        </div>
      )}

      {/* Metrics */}
      {(ret.estimatedRefund !== undefined || ret.bonusPoints !== undefined || ret.co2Saved !== undefined || ret.pickupDate) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '12px', marginBottom: '16px' }}>
          {ret.estimatedRefund !== undefined && <Metric label="Refund" value={`$${ret.estimatedRefund.toFixed(2)}`} />}
          {ret.bonusPoints !== undefined && <Metric label="Points earned" value={`+${ret.bonusPoints}`} />}
          {ret.co2Saved !== undefined && (
            <div style={{ background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '10px', padding: '14px 18px', minWidth: '110px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                <Leaf size={13} color="#10b981" aria-hidden="true" />
                <span style={{ fontSize: '11px', color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.05em' }}>CO₂ saved</span>
              </div>
              <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text)' }}>{ret.co2Saved} kg</div>
            </div>
          )}
          {ret.pickupDate && <Metric label="Pickup scheduled" value={ret.pickupDate} />}
        </div>
      )}

      {/* Next steps */}
      {ret.nextSteps && ret.nextSteps.length > 0 && (
        <div className="card" style={{ padding: '22px 26px', marginBottom: '16px' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginBottom: '14px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Next steps</h3>
          <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {ret.nextSteps.map((step, i) => (
              <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                <span style={{ width: '22px', height: '22px', borderRadius: '50%', background: 'var(--purple)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 700, color: 'white', flexShrink: 0, marginTop: '1px' }}>
                  {i + 1}
                </span>
                <span style={{ fontSize: '14px', color: 'var(--text)', lineHeight: 1.5 }}>{step}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Tracking */}
      {ret.trackingNumber && (
        <div className="card" style={{ padding: '16px 22px', marginBottom: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Tracking number</div>
            <code style={{ fontSize: '14px', color: 'var(--purple-light)', fontFamily: 'monospace', letterSpacing: '0.04em' }}>{ret.trackingNumber}</code>
          </div>
          <button
            onClick={copyTracking}
            style={{ background: copied ? 'rgba(16,185,129,0.1)' : 'rgba(255,255,255,0.05)', border: `1px solid ${copied ? 'rgba(16,185,129,0.3)' : 'var(--border)'}`, borderRadius: '6px', padding: '6px 12px', cursor: 'pointer', color: copied ? '#10b981' : 'var(--text-muted)', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '5px', transition: 'all 0.2s', flexShrink: 0, fontFamily: 'inherit' }}
          >
            {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      )}

      {/* Footer */}
      <div style={{ textAlign: 'center', marginTop: '24px' }}>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Return ID: <code style={{ fontFamily: 'monospace', color: 'var(--purple-light)' }}>{ret.returnId}</code>
        </span>
      </div>
    </div>
  );
}

function ReturnCard({ ret, onClick }: { ret: StoredReturn; onClick: () => void }) {
  const cfg = STATUS_CONFIG[ret.status] ?? STATUS_CONFIG.processing;
  const { Icon } = cfg;
  const submitted = new Date(ret.submittedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const label = statusLabel(ret);

  return (
    <button
      onClick={onClick}
      style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
    >
      <div
        className="card"
        style={{ padding: 0, overflow: 'hidden', transition: 'border-color 0.2s' }}
        onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--border-hover)')}
        onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(124,58,237,0.25)')}
      >
        {/* Header */}
        <div style={{ background: cfg.bg, borderBottom: `1px solid ${cfg.border}`, padding: '16px 24px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '34px', height: '34px', borderRadius: '50%', background: cfg.bg, border: `1px solid ${cfg.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon size={18} color={cfg.color} aria-hidden="true" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text)', textTransform: 'capitalize' }}>{label}</span>
            </div>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {ret.productNames.join(' · ')} · {ret.orderId} · {submitted}
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{ret.returnId}</span>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 4l4 4-4 4" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>

        {/* Preview metrics */}
        <div style={{ padding: '14px 24px', display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
          {ret.estimatedRefund !== undefined && (
            <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Refund: <strong style={{ color: 'var(--text)' }}>${ret.estimatedRefund.toFixed(2)}</strong></span>
          )}
          {ret.bonusPoints !== undefined && (
            <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Points: <strong style={{ color: 'var(--text)' }}>+{ret.bonusPoints}</strong></span>
          )}
          {ret.co2Saved !== undefined && (
            <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>CO₂ saved: <strong style={{ color: '#10b981' }}>{ret.co2Saved} kg</strong></span>
          )}
          {ret.pickupDate && (
            <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Pickup: <strong style={{ color: 'var(--text)' }}>{ret.pickupDate}</strong></span>
          )}
          <span style={{ fontSize: '13px', color: 'var(--purple-light)', marginLeft: 'auto' }}>View details →</span>
        </div>
      </div>
    </button>
  );
}

export default function HomePage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [returns, setReturns] = useState<StoredReturn[]>([]);
  const [selectedReturn, setSelectedReturn] = useState<StoredReturn | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const u = getUser();
    setUser(u);
    if (u) setReturns(getStoredReturns(u.email));
    setMounted(true);
  }, []);

  if (!mounted) return null;

  // ── Return detail view ──────────────────────────────────────────────────────
  if (user && selectedReturn) {
    return <ReturnDetail ret={selectedReturn} onBack={() => setSelectedReturn(null)} />;
  }

  // ── Logged-in list view ─────────────────────────────────────────────────────
  if (user) {
    return (
      <div style={{ maxWidth: '860px', margin: '0 auto', padding: '40px 24px', position: 'relative', zIndex: 1 }}>

        {/* Welcome header */}
        <div style={{ marginBottom: '32px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
              <h1 style={{ fontSize: '28px', fontWeight: 700, color: 'var(--text)' }}>
                Welcome back, {user.name.split(' ')[0]}
              </h1>
              <span style={{ background: 'rgba(124,58,237,0.15)', border: '1px solid rgba(124,58,237,0.35)', borderRadius: '999px', padding: '3px 10px', fontSize: '12px', color: 'var(--purple-light)', fontWeight: 500 }}>
                <Star size={11} style={{ verticalAlign: '-1px', marginRight: '4px' }} aria-hidden="true" />
                {user.tier} member
              </span>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '15px' }}>
              {returns.length > 0 ? `You have ${returns.length} return${returns.length > 1 ? 's' : ''} on file.` : 'No returns yet.'}
            </p>
          </div>
          <Link href="/return" className="btn-primary" style={{ fontSize: '14px', padding: '10px 22px', display: 'flex', alignItems: 'center', gap: '7px' }}>
            <RotateCcw size={14} aria-hidden="true" />
            Start a return
          </Link>
        </div>

        {/* Returns list */}
        {returns.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {returns.map(ret => (
              <ReturnCard key={ret.returnId} ret={ret} onClick={() => setSelectedReturn(ret)} />
            ))}
          </div>
        ) : (
          <div className="card" style={{ padding: '48px 32px', textAlign: 'center' }}>
            <Package size={36} color="var(--purple-light)" style={{ marginBottom: '16px', opacity: 0.6 }} aria-hidden="true" />
            <p style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>No returns yet</p>
            <p style={{ fontSize: '14px', color: 'var(--text-muted)', marginBottom: '24px' }}>When you submit a return, it will appear here.</p>
            <Link href="/return" className="btn-primary" style={{ fontSize: '14px', padding: '10px 24px' }}>
              Start your first return
            </Link>
          </div>
        )}

      </div>
    );
  }

  // ── Guest / landing view ────────────────────────────────────────────────────
  return (
    <div style={{ position: 'relative', zIndex: 1 }}>
      <section
        style={{
          minHeight: 'calc(100vh - 56px)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: '40px 24px',
          maxWidth: '860px',
          margin: '0 auto',
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            background: 'rgba(124, 58, 237, 0.12)',
            border: '1px solid rgba(124, 58, 237, 0.3)',
            borderRadius: '999px',
            padding: '6px 16px',
            fontSize: '13px',
            color: 'var(--purple-light)',
            marginBottom: '32px',
          }}
        >
          <span aria-hidden="true">✦</span>
          <span>AI-Powered Returns</span>
        </div>

        <h1
          style={{
            fontSize: 'clamp(36px, 6vw, 64px)',
            fontWeight: 700,
            lineHeight: 1.1,
            marginBottom: '24px',
            color: 'var(--text)',
            letterSpacing: '-0.02em',
          }}
        >
          Returns made <span className="gradient-text">effortless.</span>
        </h1>

        <p
          style={{
            fontSize: '18px',
            color: 'var(--text-muted)',
            maxWidth: '540px',
            lineHeight: 1.6,
            marginBottom: '40px',
          }}
        >
          Describe your issue in plain language. Our AI resolves it in minutes — fairly,
          transparently, and on your terms.
        </p>

        <div
          style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', justifyContent: 'center', marginBottom: '48px' }}
        >
          <Link href="/login" className="btn-primary" style={{ fontSize: '16px', padding: '14px 32px' }}>
            Sign in to start a return →
          </Link>
          <Link href="/return" className="btn-secondary" style={{ fontSize: '16px', padding: '14px 32px' }}>
            Continue as guest
          </Link>
        </div>

        <div style={{ display: 'flex', gap: '32px', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center' }}>
          {([
            { Icon: Clock, text: 'Average 4 min resolution' },
            { Icon: Package, text: 'Free return shipping' },
            { Icon: Zap, text: 'Instant confirmation' },
          ] as const).map(({ Icon, text }) => (
            <div key={text} style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-muted)', fontSize: '14px' }}>
              <Icon size={16} color="var(--purple-light)" aria-hidden="true" />
              <span>{text}</span>
            </div>
          ))}
        </div>
      </section>

      <section style={{ maxWidth: '860px', margin: '0 auto', padding: '80px 24px' }}>
        <h2 style={{ textAlign: 'center', fontSize: '32px', fontWeight: 700, marginBottom: '12px', color: 'var(--text)' }}>
          How it works
        </h2>
        <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '16px', marginBottom: '48px' }}>
          Three steps from problem to resolution.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '20px' }}>
          {[
            { step: '01', title: 'Tell us what happened', body: 'Describe your return in plain language — no forms, no checkboxes, just tell us.' },
            { step: '02', title: 'AI reviews your case', body: 'Our agents check your order, policy, and options instantly, working in the background.' },
            { step: '03', title: 'Get your resolution', body: 'Refund, exchange, or store credit — confirmed immediately with your next steps.' },
          ].map(({ step, title, body }) => (
            <div key={step} className="card" style={{ padding: '28px' }}>
              <div style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'var(--purple)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', fontWeight: 700, color: 'white', marginBottom: '16px' }}>
                {step}
              </div>
              <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '10px', color: 'var(--text)' }}>{title}</h3>
              <p style={{ fontSize: '14px', color: 'var(--text-muted)', lineHeight: 1.6 }}>{body}</p>
            </div>
          ))}
        </div>
      </section>

      <footer style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)', fontSize: '13px', borderTop: '1px solid var(--border)' }}>
        Powered by Cosmic Return Navigator · Accenture Cosmic Mart Case Study
      </footer>
    </div>
  );
}
