'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Clock, Package, Zap, CheckCircle, RotateCcw, Copy, Check, Leaf, Star } from 'lucide-react';
import { getUser, type AuthUser } from '@/lib/auth';

const MOCK_RETURN = {
  returnId: 'RET-84921',
  product: 'Cosmic Smartwatch Series X',
  orderId: 'ORD-20941',
  submittedDate: 'September 6, 2026',
  status: 'approved' as const,
  resolution: 'Replacement',
  resolutionDetail:
    "We're sending you a brand-new Cosmic Smartwatch Series X. It'll arrive within 3–5 business days at your registered address.",
  nextSteps: [
    'A prepaid FedEx return label has been emailed to you.',
    'Drop the item at any FedEx location by September 13.',
    'Your replacement ships once we receive the defective unit.',
  ],
  trackingNumber: '1Z999AA1012345678',
  pickupDate: 'September 9, 9am–6pm',
  co2Saved: 2.4,
  bonusPoints: 500,
};

export default function HomePage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [copied, setCopied] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setUser(getUser());
    setMounted(true);
  }, []);

  function copyTracking() {
    navigator.clipboard.writeText(MOCK_RETURN.trackingNumber).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (!mounted) return null;

  // ── Logged-in view ──────────────────────────────────────────────────────────
  if (user) {
    return (
      <div style={{ maxWidth: '860px', margin: '0 auto', padding: '40px 24px', position: 'relative', zIndex: 1 }}>

        {/* Welcome header */}
        <div style={{ marginBottom: '36px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
            <h1 style={{ fontSize: '28px', fontWeight: 700, color: 'var(--text)' }}>
              Welcome back, {user.name.split(' ')[0]}
            </h1>
            <span
              style={{
                background: 'rgba(124,58,237,0.15)',
                border: '1px solid rgba(124,58,237,0.35)',
                borderRadius: '999px',
                padding: '3px 10px',
                fontSize: '12px',
                color: 'var(--purple-light)',
                fontWeight: 500,
              }}
            >
              <Star size={11} style={{ verticalAlign: '-1px', marginRight: '4px' }} aria-hidden="true" />
              {user.tier} member
            </span>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: '15px' }}>
            Here&apos;s the status of your recent return.
          </p>
        </div>

        {/* Return card */}
        <div className="card" style={{ padding: '0', overflow: 'hidden', marginBottom: '24px' }}>

          {/* Card header */}
          <div
            style={{
              background: 'rgba(16,185,129,0.08)',
              borderBottom: '1px solid rgba(16,185,129,0.2)',
              padding: '20px 28px',
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
            }}
          >
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '50%',
                background: 'rgba(16,185,129,0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <CheckCircle size={20} color="#10b981" aria-hidden="true" />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)' }}>
                  Return approved
                </span>
                <span
                  style={{
                    background: 'rgba(16,185,129,0.12)',
                    border: '1px solid rgba(16,185,129,0.3)',
                    borderRadius: '999px',
                    padding: '2px 10px',
                    fontSize: '11px',
                    color: '#10b981',
                    fontWeight: 500,
                  }}
                >
                  {MOCK_RETURN.resolution}
                </span>
              </div>
              <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '2px' }}>
                {MOCK_RETURN.product} · {MOCK_RETURN.orderId} · Submitted {MOCK_RETURN.submittedDate}
              </p>
            </div>
            <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
              {MOCK_RETURN.returnId}
            </span>
          </div>

          {/* Card body */}
          <div style={{ padding: '24px 28px' }}>

            <p style={{ fontSize: '15px', color: 'var(--text)', lineHeight: 1.6, marginBottom: '24px' }}>
              {MOCK_RETURN.resolutionDetail}
            </p>

            {/* Metrics row */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                gap: '12px',
                marginBottom: '28px',
              }}
            >
              {[
                {
                  icon: <Package size={15} color="var(--purple-light)" aria-hidden="true" />,
                  label: 'Resolution',
                  value: MOCK_RETURN.resolution,
                },
                {
                  icon: <Star size={15} color="#fbbf24" aria-hidden="true" />,
                  label: 'Rewards earned',
                  value: `+${MOCK_RETURN.bonusPoints} pts`,
                },
                {
                  icon: <Leaf size={15} color="#10b981" aria-hidden="true" />,
                  label: 'CO₂ saved',
                  value: `${MOCK_RETURN.co2Saved} kg`,
                },
                {
                  icon: <Clock size={15} color="var(--purple-light)" aria-hidden="true" />,
                  label: 'Pickup scheduled',
                  value: MOCK_RETURN.pickupDate,
                },
              ].map(m => (
                <div
                  key={m.label}
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    padding: '12px 14px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '6px' }}>
                    {m.icon}
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      {m.label}
                    </span>
                  </div>
                  <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)' }}>{m.value}</div>
                </div>
              ))}
            </div>

            {/* Next steps */}
            <div style={{ marginBottom: '24px' }}>
              <p style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '12px' }}>
                Next steps
              </p>
              <ol style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {MOCK_RETURN.nextSteps.map((step, i) => (
                  <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', fontSize: '14px', color: 'var(--text)' }}>
                    <span
                      style={{
                        width: '20px',
                        height: '20px',
                        borderRadius: '50%',
                        background: 'var(--purple)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '11px',
                        fontWeight: 700,
                        color: 'white',
                        flexShrink: 0,
                        marginTop: '1px',
                      }}
                    >
                      {i + 1}
                    </span>
                    <span style={{ lineHeight: 1.5 }}>{step}</span>
                  </li>
                ))}
              </ol>
            </div>

            {/* Tracking number */}
            <div
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                padding: '12px 14px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px',
              }}
            >
              <div>
                <p style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '4px' }}>
                  Tracking number
                </p>
                <code style={{ fontSize: '13px', color: 'var(--purple-light)', fontFamily: 'monospace' }}>
                  {MOCK_RETURN.trackingNumber}
                </code>
              </div>
              <button
                onClick={copyTracking}
                style={{
                  background: copied ? 'rgba(16,185,129,0.1)' : 'rgba(255,255,255,0.05)',
                  border: `1px solid ${copied ? 'rgba(16,185,129,0.3)' : 'var(--border)'}`,
                  borderRadius: '6px',
                  padding: '6px 12px',
                  cursor: 'pointer',
                  color: copied ? '#10b981' : 'var(--text-muted)',
                  fontSize: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                  transition: 'all 0.2s',
                  flexShrink: 0,
                }}
              >
                {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>

          </div>
        </div>

        {/* Start another return */}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Link href="/return" className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
            <RotateCcw size={15} aria-hidden="true" />
            Start a new return
          </Link>
        </div>

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
