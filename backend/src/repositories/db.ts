/**
 * THE MOCK DATABASE.
 *
 * Fixtures are loaded ONCE at boot and validated against their Zod schemas, so
 * a malformed fixture fails loudly at startup instead of producing a confusing
 * agent error three stages into a demo run.
 *
 * Two kinds of collection live here:
 *   - REFERENCE (read-only): customers, orders, products, carriers, policy...
 *   - TRANSACTIONAL (written at runtime): cases, returns, resolutions,
 *     shipments, notifications, insights, sustainability records.
 *
 * `resetDb()` restores everything to the seeded state, which is what
 * `POST /demo/reset` calls between demo runs.
 */
import { z } from 'zod';
import { logger } from '../core/logger';
import { resetCounters, seedCounter } from '../core/ids';
import { MemoryCollection } from './memory-collection';

import { CustomerSchema, type Customer } from '../domain/customer.schema';
import { OrderSchema, type Order } from '../domain/order.schema';
import { InventorySchema, ProductSchema, type Inventory, type Product } from '../domain/product.schema';
import { ReturnPolicySchema, type ReturnPolicy } from '../domain/policy.schema';
import {
  CarrierSchema,
  DropOffLocationSchema,
  FacilitySchema,
  PackagingKitSchema,
  type Carrier,
  type DropOffLocation,
  type Facility,
  type PackagingKit,
} from '../domain/carrier.schema';
import { SustainabilityFactorsSchema, SustainabilityRecordSchema, type SustainabilityFactors, type SustainabilityRecord } from '../domain/sustainability.schema';
import { NotificationTemplateSchema, NotificationSchema, type Notification, type NotificationTemplate } from '../domain/notification.schema';
import { InsightSchema, KpiSnapshotSchema, TrendSeriesSchema, type Insight, type KpiSnapshot, type TrendSeries } from '../domain/insight.schema';
import { ReturnSchema, type Return } from '../domain/return.schema';
import { ResolutionSchema, type Resolution } from '../domain/resolution.schema';
import { ShipmentSchema, type Shipment } from '../domain/shipment.schema';
import type { ReturnCase } from '../domain/case-state.schema';

/* ---------------------------- fixture imports ----------------------------- */

import customersFixture from '../mocks/fixtures/customers.json';
import ordersFixture from '../mocks/fixtures/orders.json';
import productsFixture from '../mocks/fixtures/products.json';
import policyFixture from '../mocks/fixtures/policy.json';
import referenceFixture from '../mocks/fixtures/reference-data.json';
import templatesFixture from '../mocks/fixtures/notification-templates.json';
import historyFixture from '../mocks/fixtures/history.json';
import scenariosFixture from '../mocks/fixtures/scenarios.json';

/* ----------------------------- helper schemas ----------------------------- */

/** Per-SKU pre-aggregated history the Insights Agent trends against. */
export const SkuAggregateSchema = z.object({
  skuReturnsLast30Days: z.number().int().nonnegative(),
  skuReturnsPrevious30Days: z.number().int().nonnegative(),
  skuDamagedOnArrivalLast30Days: z.number().int().nonnegative(),
  skuReturnRatePct: z.number(),
  categoryReturnRatePct: z.number(),
  regionReturnRatePct: z.number(),
  totalReturnsLast30Days: z.number().int().nonnegative(),
});
export type SkuAggregate = z.infer<typeof SkuAggregateSchema>;

/** A named, replayable demo scenario. */
export const ScenarioSchema = z.object({
  scenarioId: z.string(),
  name: z.string(),
  isPrimary: z.boolean().default(false),
  personaLabel: z.string(),
  input: z.string(),
  customerId: z.string(),
  orderId: z.string(),
  orderItemId: z.string(),
  expected: z.record(z.string(), z.unknown()).default({}),
  narrativeBeats: z.array(z.string()).default([]),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

/* ------------------------------- validation ------------------------------- */

/**
 * Parses a fixture array, failing fast with a readable error. `_comment` keys
 * in the JSON are stripped automatically by Zod's default object behaviour.
 */
function parseFixture<T>(name: string, schema: z.ZodType<T, unknown>, raw: unknown): T[] {
  const result = z.array(schema).safeParse(raw);
  if (!result.success) {
    logger.error(`[db] Fixture '${name}' failed validation`, {
      issues: result.error.issues.slice(0, 8).map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    throw new Error(`Invalid fixture: ${name}. See the logged issues above.`);
  }
  return result.data;
}

function parseOne<T>(name: string, schema: z.ZodType<T, unknown>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    logger.error(`[db] Fixture '${name}' failed validation`, {
      issues: result.error.issues.slice(0, 8).map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    throw new Error(`Invalid fixture: ${name}. See the logged issues above.`);
  }
  return result.data;
}

/* ----------------------------- seed extraction ---------------------------- */

interface Seed {
  customers: Customer[];
  orders: Order[];
  products: Product[];
  inventory: Inventory[];
  carriers: Carrier[];
  facilities: Facility[];
  dropOffLocations: DropOffLocation[];
  packagingKits: PackagingKit[];
  notificationTemplates: NotificationTemplate[];
  insights: Insight[];
  scenarios: Scenario[];
  policy: ReturnPolicy;
  sustainabilityFactors: SustainabilityFactors;
  skuAggregates: Record<string, SkuAggregate>;
  regionReturnRatePct: Record<string, number>;
  kpiBaseline: KpiSnapshot;
  trendSeries: TrendSeries[];
  consolidationSchedule: Record<string, string>;
}

function buildSeed(): Seed {
  const ref = referenceFixture as Record<string, unknown>;
  const hist = historyFixture as Record<string, unknown>;

  return {
    customers: parseFixture('customers', CustomerSchema, customersFixture),
    orders: parseFixture('orders', OrderSchema, ordersFixture),
    products: parseFixture('products', ProductSchema, productsFixture),
    inventory: parseFixture('reference-data.inventory', InventorySchema, ref.inventory),
    carriers: parseFixture('reference-data.carriers', CarrierSchema, ref.carriers),
    facilities: parseFixture('reference-data.facilities', FacilitySchema, ref.facilities),
    dropOffLocations: parseFixture('reference-data.dropOffLocations', DropOffLocationSchema, ref.dropOffLocations),
    packagingKits: parseFixture('reference-data.packagingKits', PackagingKitSchema, ref.packagingKits),
    notificationTemplates: parseFixture('notification-templates', NotificationTemplateSchema, templatesFixture),
    insights: parseFixture('history.seedInsights', InsightSchema, hist.seedInsights),
    scenarios: parseFixture('scenarios', ScenarioSchema, scenariosFixture),
    policy: parseOne('policy', ReturnPolicySchema, policyFixture),
    sustainabilityFactors: parseOne('reference-data.sustainabilityFactors', SustainabilityFactorsSchema, ref.sustainabilityFactors),
    skuAggregates: parseOne('history.aggregatesBySku', z.record(z.string(), SkuAggregateSchema), hist.aggregatesBySku),
    regionReturnRatePct: parseOne('history.regionReturnRatePct', z.record(z.string(), z.number()), hist.regionReturnRatePct),
    kpiBaseline: parseOne('history.kpiBaseline', KpiSnapshotSchema, hist.kpiBaseline),
    trendSeries: parseFixture('history.trendSeries', TrendSeriesSchema, hist.trendSeries),
    consolidationSchedule: parseOne('reference-data.consolidationSchedule', z.record(z.string(), z.string()), ref.consolidationSchedule),
  };
}

const seed = buildSeed();

/* -------------------------------- the database ---------------------------- */

export const db = {
  /* --- reference data (read-only) --- */
  customers: new MemoryCollection<Customer>('customerId', seed.customers),
  orders: new MemoryCollection<Order>('orderId', seed.orders),
  products: new MemoryCollection<Product>('sku', seed.products),
  inventory: new MemoryCollection<Inventory>('sku', seed.inventory),
  carriers: new MemoryCollection<Carrier>('carrierId', seed.carriers),
  facilities: new MemoryCollection<Facility>('facilityId', seed.facilities),
  dropOffLocations: new MemoryCollection<DropOffLocation>('locationId', seed.dropOffLocations),
  packagingKits: new MemoryCollection<PackagingKit>('kitId', seed.packagingKits),
  notificationTemplates: new MemoryCollection<NotificationTemplate>('templateId', seed.notificationTemplates),
  scenarios: new MemoryCollection<Scenario>('scenarioId', seed.scenarios),

  /* --- transactional data (written at runtime) --- */
  cases: new MemoryCollection<ReturnCase & Record<string, unknown>>('caseId'),
  returns: new MemoryCollection<Return>('returnId'),
  resolutions: new MemoryCollection<Resolution>('resolutionId'),
  shipments: new MemoryCollection<Shipment>('shipmentId'),
  notifications: new MemoryCollection<Notification>('messageId'),
  sustainabilityRecords: new MemoryCollection<SustainabilityRecord>('recordId'),
  insights: new MemoryCollection<Insight>('insightId', seed.insights),

  /* --- singletons --- */
  policy: seed.policy,
  sustainabilityFactors: seed.sustainabilityFactors,
  skuAggregates: seed.skuAggregates,
  regionReturnRatePct: seed.regionReturnRatePct,
  kpiBaseline: seed.kpiBaseline,
  trendSeries: seed.trendSeries,
  consolidationSchedule: seed.consolidationSchedule,
};

/* ------------------------------- lifecycle -------------------------------- */

/**
 * Restores the seeded state. Called by `POST /demo/reset` so a presenter can
 * run the same scenario repeatedly and get identical output every time.
 */
export function resetDb(): void {
  db.cases.clear();
  db.returns.clear();
  db.resolutions.clear();
  db.shipments.clear();
  db.notifications.clear();
  db.sustainabilityRecords.clear();
  db.insights.reset(seed.insights);

  db.customers.reset(seed.customers);
  db.orders.reset(seed.orders);
  db.products.reset(seed.products);
  db.inventory.reset(seed.inventory);

  resetCounters();
  seedIdCounters();

  logger.info('[db] Reset to seeded fixture state.');
}

/**
 * Advances ID counters past the highest numeric suffix present in the fixtures,
 * so generated IDs never collide with seeded ones (e.g. INS-000001 exists in
 * history.json, so the next generated insight must be INS-000004).
 */
function seedIdCounters(): void {
  const maxSuffix = (ids: string[]): number =>
    ids.reduce((max, id) => {
      const n = Number.parseInt(id.split('-').pop() ?? '0', 10);
      return Number.isFinite(n) ? Math.max(max, n) : max;
    }, 0);

  seedCounter('insight', maxSuffix(db.insights.all().map((i) => i.insightId)));
}

seedIdCounters();

logger.info('[db] Fixtures loaded', {
  customers: db.customers.count(),
  orders: db.orders.count(),
  products: db.products.count(),
  carriers: db.carriers.count(),
  templates: db.notificationTemplates.count(),
  insights: db.insights.count(),
  scenarios: db.scenarios.count(),
});
