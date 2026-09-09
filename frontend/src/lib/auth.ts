export interface AuthUser {
  name: string;
  email: string;
  tier: string;
  initials: string;
  customerId: string;
  loyaltyPoints?: number;
}

export interface StoredReturn {
  returnId: string;
  orderId: string;
  returnedItemIds: string[]; // IDs of specific items returned
  productNames: string[];
  submittedAt: string; // ISO date string
  status: string;
  resolution?: string;
  resolutionDetail?: string;
  estimatedRefund?: number;
  bonusPoints?: number;
  co2Saved?: number;
  pickupDate?: string;
  trackingNumber?: string;
  nextSteps?: string[];
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

const RETURNS_PREFIX = 'crn_returns_';

export function getStoredReturns(email: string): StoredReturn[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(RETURNS_PREFIX + email);
    return raw ? (JSON.parse(raw) as StoredReturn[]) : [];
  } catch {
    return [];
  }
}

export function addStoredReturn(email: string, entry: StoredReturn): void {
  if (typeof window === 'undefined') return;
  const existing = getStoredReturns(email);
  const deduped = existing.filter(r => r.returnId !== entry.returnId);
  localStorage.setItem(RETURNS_PREFIX + email, JSON.stringify([entry, ...deduped]));
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
