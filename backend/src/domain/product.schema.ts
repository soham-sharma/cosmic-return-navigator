/**
 * DATA MODEL: Product (+ inventory + packaging)
 *
 * Not one of the seven headline models, but every agent needs it: eligibility
 * (category rules), resolution (replacement stock), logistics (dims/weight),
 * sustainability (packaging + recyclability), insights (defect trends).
 */
import { z } from 'zod';
import { IsoDateTimeSchema } from './common.schema';

/**
 * Category drives the return-window and eligibility rules. PERISHABLE and
 * FINAL_SALE are the PRD's "ineligible by category" edge case.
 */
export const ProductCategorySchema = z.enum([
  'ELECTRONICS',
  'WEARABLES',
  'APPAREL',
  'HOME',
  'BEAUTY',
  'GROCERY_PERISHABLE',
  'MEDIA',
  'ACCESSORIES',
  'FINAL_SALE',
]);
export type ProductCategory = z.infer<typeof ProductCategorySchema>;

export const DimensionsSchema = z.object({
  lengthCm: z.number().positive(),
  widthCm: z.number().positive(),
  heightCm: z.number().positive(),
  weightKg: z.number().positive(),
});
export type Dimensions = z.infer<typeof DimensionsSchema>;

/** Sustainability attributes — inputs to the Sustainability Agent's scoring. */
export const ProductSustainabilitySchema = z.object({
  /** Manufacturing footprint; used to value refurbishment vs. landfill. */
  embodiedCarbonKg: z.number().nonnegative(),
  recyclablePct: z.number().min(0).max(100),
  /** Whether the item can be restocked as-new after inspection. */
  refurbishable: z.boolean(),
  containsBattery: z.boolean().default(false),
  /** Lithium batteries restrict carrier/air options — a logistics exception. */
  hazmatClass: z.enum(['NONE', 'LITHIUM_BATTERY', 'AEROSOL', 'FLAMMABLE']).default('NONE'),
  packagingKitId: z.string().nullable().default(null),
});
export type ProductSustainability = z.infer<typeof ProductSustainabilitySchema>;

export const InventorySchema = z.object({
  sku: z.string(),
  /** Units available for immediate replacement shipment. */
  availableUnits: z.number().int().nonnegative(),
  /** Refurbished units — a cheaper, greener replacement source. */
  refurbishedUnits: z.number().int().nonnegative().default(0),
  restockEtaDays: z.number().int().nonnegative().nullable().default(null),
  /** Warehouse that would fulfil a replacement. */
  fulfillmentFacilityId: z.string(),
});
export type Inventory = z.infer<typeof InventorySchema>;

export const ProductSchema = z.object({
  sku: z.string().describe('e.g. SKU-SW-ORBIT-42'),
  name: z.string(),
  brand: z.string(),
  category: ProductCategorySchema,
  subCategory: z.string().nullable().default(null),
  priceUsd: z.number().nonnegative(),
  /** Cost of goods — needed to compute the true cost of each resolution. */
  unitCostUsd: z.number().nonnegative(),
  dimensions: DimensionsSchema,
  sustainability: ProductSustainabilitySchema,

  /** Category/SKU-level policy overrides. Null = inherit category default. */
  returnWindowDaysOverride: z.number().int().nonnegative().nullable().default(null),
  isFinalSale: z.boolean().default(false),
  isPerishable: z.boolean().default(false),
  /** Serialized goods (electronics) can be verified against the order. */
  isSerialized: z.boolean().default(false),
  warrantyMonths: z.number().int().nonnegative().default(0),
  repairable: z.boolean().default(false),

  /** Pre-aggregated quality signals the Insights Agent trends over. */
  defectRatePct: z.number().min(0).max(100).default(0),
  supplierId: z.string().nullable().default(null),

  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Product = z.infer<typeof ProductSchema>;
