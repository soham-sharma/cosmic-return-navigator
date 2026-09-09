/**
 * AUTH ROUTES — demo login for the customer-facing portal.
 *
 * POST /api/v1/auth/login   { email, password } → customer profile (no password field)
 *
 * This is a fixture-based demo: passwords are stored in customers.json.
 * There is no hashing or token issuance — the frontend stores the profile
 * in localStorage and sends customerId on every request.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../../repositories/db';
import { validate } from '../middleware/validate';

export const authRouter = Router();

const LoginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post('/login', validate(LoginBodySchema, 'body'), (req: Request, res: Response) => {
  const { email, password } = req.body as { email: string; password: string };

  const customer = db.customers.find((c) => c.email === email)[0];

  if (!customer || customer.password !== password) {
    res.status(401).json({
      success: false,
      error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' },
    });
    return;
  }

  // Never return the password field to the frontend.
  const { password: _pw, ...safeCustomer } = customer;

  res.ok({
    customerId: safeCustomer.customerId,
    name: `${safeCustomer.firstName} ${safeCustomer.lastName}`,
    email: safeCustomer.email,
    tier: safeCustomer.loyaltyTier,
    loyaltyPoints: safeCustomer.loyaltyPoints,
    initials: `${safeCustomer.firstName[0]}${safeCustomer.lastName[0]}`.toUpperCase(),
    defaultAddress: safeCustomer.defaultAddress,
  });
});
