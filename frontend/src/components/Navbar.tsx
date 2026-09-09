'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogOut, Sun, Moon } from 'lucide-react';
import { getUser, logout, type AuthUser } from '@/lib/auth';

const THEME_KEY = 'crn_theme';

export default function Navbar() {
  const pathname = usePathname();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [mounted, setMounted] = useState(false);

  // Re-read auth on every route change so logging in/out always reflects immediately.
  useEffect(() => {
    setUser(getUser());
    if (!mounted) {
      const saved = (localStorage.getItem(THEME_KEY) as 'dark' | 'light') || 'dark';
      setTheme(saved);
      document.documentElement.setAttribute('data-theme', saved);
      setMounted(true);
    }
  }, [pathname]);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    localStorage.setItem(THEME_KEY, next);
    document.documentElement.setAttribute('data-theme', next);
  }

  function handleLogout() {
    logout();
    setUser(null);
    window.location.replace('/');
  }

  const iconBtn: React.CSSProperties = {
    background: 'transparent',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    padding: '5px 8px',
    cursor: 'pointer',
    color: 'var(--text-muted)',
    display: 'flex',
    alignItems: 'center',
  };

  return (
    <nav
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        background: 'var(--nav-bg)',
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
        <span style={{ color: 'var(--text)', fontSize: '16px', fontWeight: 600, letterSpacing: '-0.01em' }}>
          Cosmic Mart
        </span>
      </Link>

      {/* Right nav — rendered only after mount to avoid sign-in flash for logged-in users */}
      {mounted && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
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

              <button onClick={handleLogout} title="Sign out" style={iconBtn}>
                <LogOut size={14} aria-hidden="true" />
              </button>
            </>
          ) : (
            <Link href="/login" className="btn-primary" style={{ fontSize: '13px', padding: '7px 18px' }}>
              Sign in
            </Link>
          )}

          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            style={iconBtn}
          >
            {theme === 'dark'
              ? <Sun size={14} aria-hidden="true" />
              : <Moon size={14} aria-hidden="true" />}
          </button>
        </div>
      )}
    </nav>
  );
}
