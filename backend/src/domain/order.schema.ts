/**
 * DATA MODEL: Order
 *
 * The authoritative record the Eligibility Agent validates a return against.
 * `deliveredAt` (not `placedAt`) is the legally relevant clock start in most
 * regions — both are captured so rules can choose.
 */
import { z } from 'zod';
import { AddressSchema, CurrencySchema, IsoDateTimeSchema } from './common.schema';

export const OrderStatusSchema = z.enum([
  'PENDING',
  'CONFIRMED',
  'SHIPPED',
  'DELIVERED',
  'PARTIALLY_RETURNED',
  'RETURNED',
  'CANCELLED',
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

/** Condition recorded at delivery — the "damaged on arrival" evidence trail. */
export const DeliveryConditionSchema = z.enum([
  'UNKNOWN',
  'GOOD',
  'PACKAGE_DAMAGED',
  'CARRIER_EXCEPTION',
  'LEFT_UNATTENDED',
]);

export const OrderItemSchema = z.object({
  orderItemId: z.string().describe('Stable line-item ID; a return targets this'),
  sku: z.string(),
  productName: z.string().describe('Denormalized for display convenience'),
  quantity: z.number().int().positive(),
  unitPriceUsd: z.number().nonnegative(),
  discountUsd: z.number().nonnegative().default(0),
  taxUsd: z.number().nonnegative().default(0),
  /** quantity * unitPrice - discount + tax. */
  lineTotalUsd: z.number().nonnegative(),
  serialNumber: z.string().nullable().default(null),
  /** Quantity already returned on previous requests (partial returns). */
  returnedQuantity: z.number().int().nonnegative().default(0),
  giftWrapped: z.boolean().default(false),
});
export type OrderItem = z.infer<typeof OrderItemSchema>;

export const OrderSchema = z.object({
  orderId: z.string().describe('e.g. ORD-088213'),
  customerId: z.string(),
  status: OrderStatusSchema,

  placedAt: IsoDateTimeSchema,
  shippedAt: IsoDateTimeSchema.nullable().default(null),
  /** Return-window clock usually starts here. */
  deliveredAt: IsoDateTimeSchema.nullable().default(null),

  items: z.array(OrderItemSchema).min(1),

  currency: CurrencySchema.default('USD'),
  subtotalUsd: z.number().nonnegative(),
  shippingUsd: z.number().nonnegative().default(0),
  taxUsd: z.number().nonnegative().default(0),
  totalUsd: z.number().nonnegative(),

  shippingAddress: AddressSchema,
  billingAddress: AddressSchema.nullable().default(null),

  paymentMethod: z.enum(['CARD', 'WALLET', 'COSMIC_CREDIT', 'BNPL', 'GIFT_CARD']),
  /** Refunds to an expired card force store credit — a resolution constraint. */
  paymentInstrumentValid: z.boolean().default(true),

  /** Original outbound shipment, reused by consolidation logic. */
  outboundCarrierId: z.string().nullable().default(null),
  outboundTrackingNumber: z.string().nullable().default(null),
  deliveryCondition: DeliveryConditionSchema.default('UNKNOWN'),
  /** Facility the order shipped from; nearest return destination candidate. */
  fulfillmentFacilityId: z.string(),

  channel: z.enum(['WEB', 'MOBILE_APP', 'STORE', 'MARKETPLACE']).default('WEB'),
  isGift: z.boolean().default(false),

  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Order = z.infer<typeof OrderSchema>;
