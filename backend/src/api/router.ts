/**
 * API ROUTER — mounts every route module under /api/v1.
 *
 * The path prefixes here are the contract the frontend codes against; see
 * `GET /api/v1/meta/routes` for the machine-readable manifest and
 * docs/api_contracts.md for the full reference.
 */
import { Router } from 'express';
import { returnsRouter } from './routes/returns.routes';
import { agentsRouter } from './routes/agents.routes';
import { customersRouter, ordersRouter, productsRouter, referenceRouter } from './routes/catalog.routes';
import {
  analyticsRouter,
  insightsRouter,
  notificationsRouter,
  shipmentsRouter,
  sustainabilityRouter,
} from './routes/operations.routes';
import { demoRouter, metaRouter } from './routes/meta.routes';
import { authRouter } from './routes/auth.routes';

export const API_PREFIX = '/api/v1';

export function buildApiRouter(): Router {
  const router = Router();

  /* --- auth --- */
  router.use('/auth', authRouter);

  /* --- core workflow --- */
  router.use('/returns', returnsRouter);
  router.use('/agents', agentsRouter);

  /* --- catalogue / reference --- */
  router.use('/customers', customersRouter);
  router.use('/orders', ordersRouter);
  router.use('/products', productsRouter);
  router.use('/reference', referenceRouter);

  /* --- operations --- */
  router.use('/shipments', shipmentsRouter);
  router.use('/notifications', notificationsRouter);
  router.use('/sustainability', sustainabilityRouter);
  router.use('/insights', insightsRouter);
  router.use('/analytics', analyticsRouter);

  /* --- meta / demo control --- */
  router.use('/meta', metaRouter);
  router.use('/demo', demoRouter);

  return router;
}
