'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Package, ChevronRight, ArrowLeft } from 'lucide-react';
import { getUserOrders, submitReturn } from '@/lib/api';
import { RETURN_REASONS } from '@/lib/mock-data';
import type { Order, ReturnReason, ReturnResponse } from '@/lib/types';
import { getUser } from '@/lib/auth';
import StepProgress from '@/components/StepProgress';
import ProcessingScreen from '@/components/ProcessingScreen';
import ResolutionCard from '@/components/ResolutionCard';

const STEP_LABELS = ['Your orders', 'Select items', 'Reason & details', 'Resolution'];

export default function ReturnPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [order, setOrder] = useState<Order | null>(null);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [reason, setReason] = useState<ReturnReason | ''>('');
  const [description, setDescription] = useState('');
  const [result, setResult] = useState<ReturnResponse | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const user = getUser();
    if (!user) {
      router.replace('/login');
      return;
    }
    getUserOrders(user.email).then(o => {
      setOrders(o);
      setOrdersLoading(false);
    });
  }, [router]);

  function selectOrder(o: Order) {
    setOrder(o);
    setSelectedItemIds([]);
    setStep(2);
  }

  function toggleItem(id: string) {
    setSelectedItemIds(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  }

  async function handleSubmit() {
    if (!order || !reason) return;
    const user = getUser();
    setStep(4);
    try {
      const res = await submitReturn({
        orderId: order.id,
        email: user?.email ?? '',
        selectedItemIds,
        reason: reason as ReturnReason,
        description,
      });
      setResult(res);
    } catch {
      // ProcessingScreen stays visible — result null
    }
  }

  function formatDate(dateStr: string) {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
    });
  }

  function daysSince(dateStr: string) {
    const diff = Date.now() - new Date(dateStr).getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  }

  if (!mounted) return null;

  return (
    <div style={{ maxWidth: '760px', margin: '0 auto', padding: '40px 24px', position: 'relative', zIndex: 1 }}>

      {step < 4 && (
        <div style={{ marginBottom: '40px' }}>
          <StepProgress currentStep={step} steps={STEP_LABELS} />
        </div>
      )}

      {/* ── Step 1 — Order selection ─────────────────────────────────────────── */}
      {step === 1 && (
        <div className="fade-in">
          <h1 style={{ fontSize: '26px', fontWeight: 700, color: 'var(--text)', marginBottom: '6px' }}>
            Which order are you returning?
          </h1>
          <p style={{ fontSize: '15px', color: 'var(--text-muted)', marginBottom: '32px' }}>
            Select an order below to get started.
          </p>

          {ordersLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {[1, 2, 3].map(i => (
                <div
                  key={i}
                  style={{
                    height: '100px',
                    borderRadius: '12px',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid var(--border)',
                    animation: 'pulse 1.5s ease-in-out infinite',
                    opacity: 1 - i * 0.15,
                  }}
                />
              ))}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {orders.map(o => {
                const days = daysSince(o.date);
                const eligible = days <= 30;
                return (
                  <button
                    key={o.id}
                    onClick={() => eligible && selectOrder(o)}
                    disabled={!eligible}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      background: eligible ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.01)',
                      border: `1px solid var(--border)`,
                      borderRadius: '12px',
                      padding: '20px 24px',
                      cursor: eligible ? 'pointer' : 'not-allowed',
                      opacity: eligible ? 1 : 0.45,
                      transition: 'all 0.2s',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '20px',
                    }}
                    onMouseEnter={e => {
                      if (eligible) {
                        (e.currentTarget as HTMLElement).style.borderColor = 'var(--purple)';
                        (e.currentTarget as HTMLElement).style.background = 'var(--purple-pale)';
                      }
                    }}
                    onMouseLeave={e => {
                      (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)';
                      (e.currentTarget as HTMLElement).style.background = eligible
                        ? 'rgba(255,255,255,0.02)'
                        : 'rgba(255,255,255,0.01)';
                    }}
                  >
                    {/* Order icon */}
                    <div
                      style={{
                        width: '48px',
                        height: '48px',
                        borderRadius: '10px',
                        background: 'rgba(124,58,237,0.12)',
                        border: '1px solid rgba(124,58,237,0.25)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <Package size={22} color="var(--purple-light)" aria-hidden="true" />
                    </div>

                    {/* Order details */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '5px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text)', fontFamily: 'monospace' }}>
                          {o.id}
                        </span>
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                          {formatDate(o.date)}
                        </span>
                        {!eligible && (
                          <span
                            style={{
                              fontSize: '11px',
                              background: 'rgba(239,68,68,0.1)',
                              border: '1px solid rgba(239,68,68,0.2)',
                              color: '#f87171',
                              borderRadius: '999px',
                              padding: '1px 8px',
                            }}
                          >
                            Outside return window
                          </span>
                        )}
                        {eligible && days <= 5 && (
                          <span
                            style={{
                              fontSize: '11px',
                              background: 'rgba(251,191,36,0.1)',
                              border: '1px solid rgba(251,191,36,0.2)',
                              color: '#fbbf24',
                              borderRadius: '999px',
                              padding: '1px 8px',
                            }}
                          >
                            {30 - days} days left to return
                          </span>
                        )}
                      </div>

                      {/* Item names */}
                      <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {o.items.map(i => i.name).join(' · ')}
                      </div>

                      {/* Footer row */}
                      <div style={{ display: 'flex', gap: '16px', fontSize: '12px', color: 'var(--text-muted)' }}>
                        <span>{o.items.reduce((acc, i) => acc + i.quantity, 0)} items</span>
                        <span>${o.total.toFixed(2)}</span>
                        <span>{days} days ago</span>
                      </div>
                    </div>

                    {eligible && (
                      <ChevronRight size={20} color="var(--text-muted)" aria-hidden="true" style={{ flexShrink: 0 }} />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Step 2 — Select items ─────────────────────────────────────────────── */}
      {step === 2 && order && (
        <div className="fade-in">
          <button
            onClick={() => setStep(1)}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '13px', marginBottom: '24px', padding: 0 }}
          >
            <ArrowLeft size={14} aria-hidden="true" /> Back to orders
          </button>

          <h1 style={{ fontSize: '26px', fontWeight: 700, color: 'var(--text)', marginBottom: '6px' }}>
            Which items are you returning?
          </h1>
          <p style={{ fontSize: '15px', color: 'var(--text-muted)', marginBottom: '8px' }}>
            Select one or more items from order{' '}
            <span style={{ fontFamily: 'monospace', color: 'var(--purple-light)' }}>{order.id}</span>.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px', marginTop: '24px' }}>
            {order.items.map(item => {
              const selected = selectedItemIds.includes(item.id);
              return (
                <div
                  key={item.id}
                  role="checkbox"
                  aria-checked={selected}
                  tabIndex={0}
                  onClick={() => toggleItem(item.id)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') toggleItem(item.id); }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '16px',
                    padding: '16px 20px',
                    border: `1px solid ${selected ? 'var(--purple)' : 'var(--border)'}`,
                    borderRadius: '10px',
                    background: selected ? 'var(--purple-pale)' : 'rgba(255,255,255,0.02)',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    outline: 'none',
                  }}
                >
                  <div
                    style={{
                      width: '20px', height: '20px', borderRadius: '4px', flexShrink: 0,
                      border: `2px solid ${selected ? 'var(--purple)' : 'rgba(255,255,255,0.2)'}`,
                      background: selected ? 'var(--purple)' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      transition: 'all 0.15s',
                    }}
                  >
                    {selected && (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                        <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text)', marginBottom: '2px' }}>
                      {item.name}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                      {item.sku} · Qty {item.quantity}
                    </div>
                  </div>
                  <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text)' }}>
                    ${item.price.toFixed(2)}
                  </div>
                </div>
              );
            })}
          </div>

          <div
            style={{
              padding: '12px 16px', background: 'rgba(124,58,237,0.06)',
              border: '1px solid var(--border)', borderRadius: '8px',
              fontSize: '13px', color: 'var(--text-muted)', marginBottom: '24px',
            }}
          >
            Order {order.id} · {formatDate(order.date)} · Total ${order.total.toFixed(2)}
          </div>

          <button
            className="btn-primary"
            style={{ width: '100%' }}
            onClick={() => setStep(3)}
            disabled={selectedItemIds.length === 0}
          >
            Continue →
          </button>
        </div>
      )}

      {/* ── Step 3 — Reason & details ─────────────────────────────────────────── */}
      {step === 3 && (
        <div className="fade-in">
          <button
            onClick={() => setStep(2)}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '13px', marginBottom: '24px', padding: 0 }}
          >
            <ArrowLeft size={14} aria-hidden="true" /> Back to items
          </button>

          <h1 style={{ fontSize: '26px', fontWeight: 700, color: 'var(--text)', marginBottom: '6px' }}>
            Why are you returning?
          </h1>
          <p style={{ fontSize: '15px', color: 'var(--text-muted)', marginBottom: '28px' }}>
            Select the reason that best describes your situation.
          </p>

          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px', marginBottom: '24px' }}
          >
            {RETURN_REASONS.map(r => {
              const selected = reason === r.value;
              return (
                <div
                  key={r.value}
                  role="radio"
                  aria-checked={selected}
                  tabIndex={0}
                  onClick={() => setReason(r.value)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setReason(r.value); }}
                  style={{
                    padding: '16px 18px',
                    border: `1px solid ${selected ? 'var(--purple)' : 'var(--border)'}`,
                    borderRadius: '10px',
                    background: selected ? 'var(--purple-pale)' : 'rgba(255,255,255,0.02)',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    outline: 'none',
                  }}
                >
                  <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginBottom: '4px' }}>
                    {r.label}
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                    {r.description}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ marginBottom: '24px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: 'var(--text-muted)', marginBottom: '6px' }}>
              Tell us more (optional)
            </label>
            <textarea
              className="input"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Any additional details about the issue..."
              style={{ minHeight: '100px', resize: 'vertical' }}
            />
          </div>

          <button
            className="btn-primary"
            style={{ width: '100%' }}
            onClick={handleSubmit}
            disabled={!reason}
          >
            Submit return →
          </button>
        </div>
      )}

      {/* ── Step 4 — Processing & result ─────────────────────────────────────── */}
      {step === 4 && (
        <div className="fade-in">
          {result ? <ResolutionCard result={result} /> : <ProcessingScreen />}
        </div>
      )}

      {/* Guest fallback link */}
      {step === 1 && !ordersLoading && (
        <p style={{ textAlign: 'center', marginTop: '32px', fontSize: '13px', color: 'var(--text-muted)' }}>
          Not your account?{' '}
          <Link href="/login" style={{ color: 'var(--purple-light)', textDecoration: 'none' }}>
            Sign in with a different account
          </Link>
        </p>
      )}
    </div>
  );
}
