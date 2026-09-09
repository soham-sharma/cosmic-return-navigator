'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { getUser, logout, type AuthUser } from '@/lib/auth';

export default function Navbar() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    setUser(getUser());
  }, []);

  function handleLogout() {
    logout();
    setUser(null);
    router.push('/');
  }

  return (
    <nav
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        background: 'rgba(5, 5, 20, 0.8)',
        backdropFilter: 'blur(16px)',
        borderBottom: '1px solid var(--border)',
        padding: '0 32px',
        height: '56px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      {/* Brand */}
      <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: '10px', textDecoration: 'none' }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="10" stroke="#a78bfa" strokeWidth="1.5" />
          <ellipse cx="12" cy="12" rx="4" ry="10" stroke="#7c3aed" strokeWidth="1.5" />
          <ellipse cx="12" cy="12" rx="10" ry="4" stroke="#7c3aed" strokeWidth="1.5" opacity="0.5" />
          <circle cx="12" cy="12" r="2" fill="#a78bfa" />
        </svg>
        <span style={{ color: 'white', fontSize: '16px', fontWeight: 600, letterSpacing: '-0.01em' }}>
          Cosmic Mart
        </span>
      </Link>

      {/* Right nav */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
        {user ? (
          <>
            <Link href="/return" className="nav-link" style={{ fontSize: '14px' }}>
              New return
            </Link>

            <Link href="/kpi" className="nav-link" style={{ fontSize: '14px' }}>
              KPI Dashboard
            </Link>

            {/* User chip */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  background: 'var(--purple)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '12px',
                  fontWeight: 700,
                  color: 'white',
                  flexShrink: 0,
                }}
              >
                {user.initials}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text)', lineHeight: 1.2 }}>
                  {user.name}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--purple-light)', lineHeight: 1.2 }}>
                  {user.tier} member
                </span>
              </div>
            </div>

            <button
              onClick={handleLogout}
              title="Sign out"
              style={{
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                padding: '5px 8px',
                cursor: 'pointer',
                color: 'var(--text-muted)',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <LogOut size={14} aria-hidden="true" />
            </button>
          </>
        ) : (
          <>
            <Link href="/return" className="nav-link" style={{ fontSize: '14px' }}>
              Track a return
            </Link>
            <Link
              href="/login"
              className="btn-primary"
              style={{ fontSize: '13px', padding: '7px 18px' }}
            >
              Sign in
            </Link>
          </>
        )}
      </div>
    </nav>
  );
}
