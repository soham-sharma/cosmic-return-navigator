'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { login, DEMO_CUSTOMERS } from '@/lib/auth';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) {
      setError('Please enter your email and password.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed.');
    } finally {
      setLoading(false);
    }
  }

  function fillDemo(idx: number) {
    const c = DEMO_CUSTOMERS[idx];
    if (c) {
      setEmail(c.email);
      setPassword(c.password);
      setError('');
    }
  }

  return (
    <div
      style={{
        minHeight: 'calc(100vh - 56px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
    >
      <div style={{ width: '100%', maxWidth: '420px' }}>

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div
            style={{
              width: '52px',
              height: '52px',
              borderRadius: '50%',
              background: 'rgba(124,58,237,0.15)',
              border: '1px solid rgba(124,58,237,0.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 16px',
            }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="10" stroke="#a78bfa" strokeWidth="1.5" />
              <ellipse cx="12" cy="12" rx="4" ry="10" stroke="#7c3aed" strokeWidth="1.5" />
              <ellipse cx="12" cy="12" rx="10" ry="4" stroke="#7c3aed" strokeWidth="1.5" opacity="0.5" />
              <circle cx="12" cy="12" r="2" fill="#a78bfa" />
            </svg>
          </div>
          <h1 style={{ fontSize: '24px', fontWeight: 700, color: 'var(--text)', marginBottom: '6px' }}>
            Sign in to Cosmic Mart
          </h1>
          <p style={{ fontSize: '14px', color: 'var(--text-muted)' }}>
            Access your orders and manage returns
          </p>
        </div>

        {/* Card */}
        <div className="card" style={{ padding: '32px' }}>
          <form onSubmit={handleSubmit} noValidate>

            <div style={{ marginBottom: '20px' }}>
              <label
                htmlFor="email"
                style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: 'var(--text-muted)', marginBottom: '8px' }}
              >
                Email address
              </label>
              <input
                id="email"
                type="email"
                className="input"
                placeholder="you@example.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>

            <div style={{ marginBottom: '24px' }}>
              <label
                htmlFor="password"
                style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: 'var(--text-muted)', marginBottom: '8px' }}
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                className="input"
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>

            {error && (
              <div
                style={{
                  background: 'rgba(239,68,68,0.08)',
                  border: '1px solid rgba(239,68,68,0.25)',
                  borderRadius: '8px',
                  padding: '10px 14px',
                  fontSize: '13px',
                  color: '#f87171',
                  marginBottom: '20px',
                }}
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              className="btn-primary"
              disabled={loading}
              style={{ width: '100%', fontSize: '15px', padding: '13px', opacity: loading ? 0.7 : 1 }}
            >
              {loading ? (
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                  <span className="spinner" style={{ width: '16px', height: '16px', border: '2px solid rgba(255,255,255,0.3)', borderTop: '2px solid white', borderRadius: '50%', display: 'inline-block' }} />
                  Signing in…
                </span>
              ) : (
                'Sign in'
              )}
            </button>
          </form>
        </div>

        {/* Demo accounts */}
        <div
          style={{
            marginTop: '20px',
            background: 'rgba(124,58,237,0.06)',
            border: '1px solid rgba(124,58,237,0.2)',
            borderRadius: '10px',
            padding: '16px 20px',
          }}
        >
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px', fontWeight: 500 }}>
            Demo accounts — password for all: <span style={{ fontFamily: 'monospace', color: 'var(--purple-light)' }}>cosmic123</span>
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {DEMO_CUSTOMERS.map((c, i) => (
              <button
                key={c.email}
                onClick={() => fillDemo(i)}
                className="btn-secondary"
                style={{ fontSize: '12px', padding: '6px 12px', textAlign: 'left', width: '100%' }}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <p style={{ textAlign: 'center', marginTop: '24px', fontSize: '13px', color: 'var(--text-muted)' }}>
          Don&apos;t have an account?{' '}
          <Link href="/" style={{ color: 'var(--purple-light)', textDecoration: 'none' }}>
            Continue as guest
          </Link>
        </p>

      </div>
    </div>
  );
}
