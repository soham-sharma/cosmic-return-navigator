export interface AuthUser {
  name: string;
  email: string;
  tier: string;
  initials: string;
  customerId: string;
  loyaltyPoints?: number;
}

const AUTH_KEY = 'crn_auth';

const BACKEND_ORIGIN = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:4000';

export const DEMO_CUSTOMERS: Array<{ email: string; password: string; label: string }> = [
  { email: 'alex.rivera@example.com',   password: 'cosmic123', label: 'Alex Rivera — Gold' },
  { email: 'priya.raman@example.com',   password: 'cosmic123', label: 'Priya Raman — Platinum VIP' },
  { email: 'morgan.diaz@example.com',   password: 'cosmic123', label: 'Morgan Diaz — Gold' },
  { email: 'sana.iqbal@example.com.au', password: 'cosmic123', label: 'Sana Iqbal — Gold (Remote AU)' },
  { email: 'tomas.vogel@example.de',    password: 'cosmic123', label: 'Tomas Vogel — Silver (EU)' },
  { email: 'jamie.osei@example.com',    password: 'cosmic123', label: 'Jamie Osei — Standard' },
  { email: 'riley.chen@example.com',    password: 'cosmic123', label: 'Riley Chen — Standard (Fraud)' },
];

export async function login(email: string, password: string): Promise<AuthUser> {
  const res = await fetch(`${BACKEND_ORIGIN}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok || !body.success) {
    throw new Error(body.error?.message ?? 'Invalid email or password.');
  }
  const user: AuthUser = body.data;
  if (typeof window !== 'undefined') {
    localStorage.setItem(AUTH_KEY, JSON.stringify(user));
  }
  return user;
}

export function logout(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(AUTH_KEY);
}

export function getUser(): AuthUser | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}
