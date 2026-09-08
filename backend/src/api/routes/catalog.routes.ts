/**
 * CATALOGUE ROUTES — read-only reference data the frontend needs to build
 * screens: customers, orders, products, carriers and the return policy.
 *
 * Base paths: /api/v1/customers, /orders, /products, /policy, /reference
 */
import { Router, type Request, type Response } from 'express';
import { notFound } from '../../core/errors';
import { db } from '../../repositories/db';
import { paginate } from '../../repositories/memory-collection';
import { validate } from '../middleware/validate';
import { PaginationQuerySchema, type PaginationQuery } from '../../domain/common.schema';
import {
  CustomerIdParamsSchema,
  OrderIdParamsSchema,
  OrderListQuerySchema,
  SkuParamsSchema,
} from '../contracts/api.schema';
import { daysBetween } from '../../core/clock';
import { listCases, toSummary } from '../../orchestrator/state-store';

export const customersRouter = Router();
export const ordersRouter = Router();
export const productsRouter = Router();
export const referenceRouter = Router();

/* ========================================================================== */
/* Customers                                                                  */
/* ========================================================================== */

customersRouter.get('/', validate(PaginationQuerySchema, 'query'), (req: Request, res: Response) => {
  const q = req.query as unknown as PaginationQuery;
  const { items, pagination } = paginate(db.customers.all(), q.page, q.pageSize);
  res.ok(items, pagination);
});

customersRouter.get('/:customerId', validate(CustomerIdParamsSchema, 'params'), (req: Request, res: Response) => {
  const customer = db.customers.get(req.params.customerId as string);
  if (!customer) throw notFound('Customer', req.params.customerId as string);
  res.ok(customer);
});

/**
 * GET /api/v1/customers/:customerId/orders
 * Powers the "pick the order you want to return" step, which is the path that
 * avoids fuzzy intent resolution entirely.
 */
customersRouter.get('/:customerId/orders', validate(CustomerIdParamsSchema, 'params'), (req: Request, res: Response) => {
  const customerId = req.params.customerId as string;
  if (!db.customers.has(customerId)) throw notFound('Customer', customerId);

  const orders = db.orders
    .find((o) => o.customerId === customerId)
    .sort((a, b) => (b.deliveredAt ?? b.placedAt).localeCompare(a.deliveredAt ?? a.placedAt))
    .map(decorateOrder);

  res.ok(orders);
});

/** GET /api/v1/customers/:customerId/returns — this customer's case history. */
customersRouter.get('/:customerId/returns', validate(CustomerIdParamsSchema, 'params'), (req: Request, res: Response) => {
  const customerId = req.params.customerId as string;
  res.ok({
    cases: listCases().filter((c) => c.intent?.customerId === customerId).map(toSummary),
    returns: db.returns.find((r) => r.customerId === customerId),
  });
});

/* ========================================================================== */
/* Orders                                                                     */
/* ========================================================================== */

ordersRouter.get('/', validate(OrderListQuerySchema, 'query'), (req: Request, res: Response) => {
  const q = req.query as unknown as PaginationQuery & { customerId?: string; status?: string; returnableOnly?: boolean };

  let orders = db.orders.all();
  if (q.customerId) orders = orders.filter((o) => o.customerId === q.customerId);
  if (q.status) orders = orders.filter((o) => o.status === q.status);
  if (q.returnableOnly) {
    orders = orders.filter((o) => o.items.some((i) => i.quantity - i.returnedQuantity > 0));
  }

  const decorated = orders
    .sort((a, b) => (b.deliveredAt ?? b.placedAt).localeCompare(a.deliveredAt ?? a.placedAt))
    .map(decorateOrder);

  const { items, pagination } = paginate(decorated, q.page, q.pageSize);
  res.ok(items, pagination);
});

ordersRouter.get('/:orderId', validate(OrderIdParamsSchema, 'params'), (req: Request, res: Response) => {
  const order = db.orders.get(req.params.orderId as string);
  if (!order) throw notFound('Order', req.params.orderId as string);
  res.ok(decorateOrder(order));
});

/**
 * Adds derived, UI-friendly fields so the frontend does not re-implement policy
 * arithmetic: days since delivery, the window that applies, and whether each
 * line item is still returnable.
 */
function decorateOrder(order: ReturnType<typeof db.orders.all>[number]) {
  const daysSinceDelivery = order.deliveredAt ? daysBetween(order.deliveredAt) : null;

  return {
    ...order,
    derived: {
      daysSinceDelivery,
      daysSincePurchase: daysBetween(order.placedAt),
      customerName: (() => {
        const c = db.customers.get(order.customerId);
        return c ? `${c.firstName} ${c.lastName}` : null;
      })(),
      items: order.items.map((item) => {
        const product = db.products.get(item.sku);
        const categoryPolicy = db.policy.categories.find((c) => c.category === product?.category);
        const tier = db.customers.get(order.customerId)?.loyaltyTier;
        const tierBenefit = db.policy.tierBenefits.find((t) => t.tier === tier);

        // Base window shown to the customer BEFORE any reason-specific
        // extension — the Eligibility Agent computes the real effective window.
        const baseWindow =
          (product?.returnWindowDaysOverride ?? categoryPolicy?.returnWindowDays ?? db.policy.defaultReturnWindowDays) +
          (tierBenefit?.windowExtensionDays ?? 0);

        const returnableQuantity = item.quantity - item.returnedQuantity;
        const withinWindow = daysSinceDelivery === null ? false : daysSinceDelivery <= baseWindow;

        return {
          orderItemId: item.orderItemId,
          sku: item.sku,
          productName: item.productName,
          returnableQuantity,
          baseReturnWindowDays: baseWindow,
          withinWindow,
          categoryReturnable: categoryPolicy?.returnable ?? true,
          nonReturnableReason: categoryPolicy?.returnable === false ? categoryPolicy.nonReturnableReason : null,
          daysRemaining: daysSinceDelivery === null ? null : baseWindow - daysSinceDelivery,
        };
      }),
    },
  };
}

/* ========================================================================== */
/* Products                                                                   */
/* ========================================================================== */

productsRouter.get('/', validate(PaginationQuerySchema, 'query'), (req: Request, res: Response) => {
  const q = req.query as unknown as PaginationQuery;
  const withInventory = db.products.all().map((p) => ({ ...p, inventory: db.inventory.get(p.sku) ?? null }));
  const { items, pagination } = paginate(withInventory, q.page, q.pageSize);
  res.ok(items, pagination);
});

productsRouter.get('/:sku', validate(SkuParamsSchema, 'params'), (req: Request, res: Response) => {
  const sku = req.params.sku as string;
  const product = db.products.get(sku);
  if (!product) throw notFound('Product', sku);

  res.ok({
    ...product,
    inventory: db.inventory.get(sku) ?? null,
    returnHistory: db.skuAggregates[sku] ?? null,
    openInsights: db.insights.find((i) => i.sku === sku && i.status !== 'DISMISSED' && i.status !== 'ACTIONED'),
  });
});

/* ========================================================================== */
/* Policy and reference data                                                  */
/* ========================================================================== */

/**
 * GET /api/v1/reference/policy
 * The whole return policy as data. The frontend renders the customer-facing
 * policy page from this rather than hardcoding copy — which is how "the policy
 * is complicated" stops being a code problem.
 */
referenceRouter.get('/policy', (_req: Request, res: Response) => {
  res.ok(db.policy);
});

referenceRouter.get('/carriers', (_req: Request, res: Response) => {
  res.ok(db.carriers.all());
});

referenceRouter.get('/facilities', (_req: Request, res: Response) => {
  res.ok(db.facilities.all());
});

referenceRouter.get('/drop-off-locations', (_req: Request, res: Response) => {
  res.ok(db.dropOffLocations.all());
});

referenceRouter.get('/packaging-kits', (_req: Request, res: Response) => {
  res.ok(db.packagingKits.all());
});

referenceRouter.get('/sustainability-factors', (_req: Request, res: Response) => {
  res.ok(db.sustainabilityFactors);
});

referenceRouter.get('/notification-templates', (_req: Request, res: Response) => {
  res.ok(db.notificationTemplates.all());
});

/**
 * GET /api/v1/reference/enums
 * Every closed enum in one call, so the frontend can build dropdowns, badge
 * colour maps and filter chips without duplicating the string literals.
 */
referenceRouter.get('/enums', (_req: Request, res: Response) => {
  res.ok({
    returnReasons: db.policy.reasonPolicies.map((r) => r.reason),
    categories: db.policy.categories.map((c) => c.category),
    loyaltyTiers: db.policy.tierBenefits.map((t) => t.tier),
    regions: db.policy.regionalRules.map((r) => ({ code: r.regionCode, name: r.regionName })),
    resolutionTypes: [
      'REFUND', 'KEEP_AND_REFUND', 'PARTIAL_REFUND', 'REPLACEMENT', 'EXCHANGE', 'STORE_CREDIT', 'REPAIR', 'ESCALATE', 'DENY',
    ],
    returnMethods: ['HOME_PICKUP', 'DROP_OFF_POINT', 'STORE_DROP_OFF', 'LOCKER', 'NO_RETURN_REQUIRED'],
    caseStatuses: [
      'RECEIVED', 'PARSING', 'AWAITING_CLARIFICATION', 'RUNNING', 'AWAITING_HUMAN_REVIEW', 'COMPLETED', 'ESCALATED', 'DENIED', 'CANCELLED', 'FAILED',
    ],
    agentRunStatuses: ['PENDING', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'ESCALATED', 'SKIPPED', 'FAILED'],
    sustainabilityGrades: ['A', 'B', 'C', 'D', 'F'],
    dispositionPaths: [
      'RESTOCK_AS_NEW', 'REFURBISH_RESELL', 'REPAIR_RETURN_TO_CUSTOMER', 'PARTS_HARVEST', 'DONATE', 'RECYCLE', 'LIQUIDATE', 'LANDFILL', 'NO_MOVEMENT',
    ],
  });
});
