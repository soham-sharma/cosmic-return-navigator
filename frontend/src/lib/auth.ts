export interface AuthUser {
  name: string;
  email: string;
  tier: 'Bronze' | 'Silver' | 'Gold' | 'Platinum';
  initials: string;
  customerId: string;
}

const AUTH_KEY = 'crn_auth';

export const MOCK_CREDENTIALS = {
  email: 'alex.rivera@example.com',
  password: 'cosmic123',
};

const MOCK_USER: AuthUser = {
  name: 'Alex Rivera',
  email: 'alex.rivera@example.com',
  tier: 'Gold',
  initials: 'AR',
  customerId: 'CUST-001001',
};

export function login(email: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(AUTH_KEY, JSON.stringify({ ...MOCK_USER, email }));
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
