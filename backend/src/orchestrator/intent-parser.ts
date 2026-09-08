/**
 * INTENT PARSER — stage 0, owned by the orchestrator (not an agent).
 *
 * Turns messy free text ("I bought a smartwatch 20 days ago, it arrived
 * damaged") into a structured `ReturnIntent`. This is the PRD's
 * "natural-language return intake that normalizes messy input".
 *
 * WHY IT IS NOT AN AGENT: parsing is a prerequisite for every agent, it has no
 * business judgement, and it needs repository access to resolve orders. Making
 * it orchestrator-owned keeps all seven agents pure.
 *
 * STATUS: wireframe. Pattern matching is real (the demo depends on it) but
 * intentionally shallow. TODO markers show where a production system would
 * swap in an LLM extraction call — the OUTPUT CONTRACT would not change, which
 * is the point of keeping this behind a function boundary.
 */
import { clock, daysBetween } from '../core/clock';
import { db } from '../repositories/db';
import type { Customer } from '../domain/customer.schema';
import type { Order, OrderItem } from '../domain/order.schema';
import {
  type FaultAttribution,
  type ItemCondition,
  type RequestedOutcome,
  type ReturnIntent,
  type ReturnReason,
} from '../domain/return.schema';

/* -------------------------------------------------------------------------- */
/* Pattern tables — extend these rather than adding branches below.            */
/* -------------------------------------------------------------------------- */

/** Ordered by specificity: the FIRST match wins, so put narrow patterns first. */
const REASON_PATTERNS: { reason: ReturnReason; patterns: RegExp[]; fault: FaultAttribution; condition: ItemCondition }[] = [
  {
    reason: 'DAMAGED_ON_ARRIVAL',
    patterns: [/arrived\s+(damaged|broken|smashed|cracked)/i, /damaged\s+(on\s+arrival|in\s+transit)/i, /\b(smashed|shattered|crushed)\b/i, /came\s+(damaged|broken)/i, /box\s+was\s+(crushed|damaged)/i],
    fault: 'MERCHANT',
    condition: 'DAMAGED',
  },
  {
    reason: 'WRONG_ITEM_SENT',
    patterns: [/wrong\s+(item|product|thing|size\s+sent)/i, /not\s+what\s+i\s+ordered/i, /sent\s+me\s+the\s+wrong/i],
    fault: 'MERCHANT',
    condition: 'NEW_UNOPENED',
  },
  {
    reason: 'MISSING_PARTS',
    patterns: [/missing\s+(parts?|pieces?|charger|cable|accessor)/i, /(parts?|pieces?)\s+missing/i, /incomplete/i],
    fault: 'MERCHANT',
    condition: 'OPENED_LIKE_NEW',
  },
  {
    reason: 'DEFECTIVE',
    patterns: [/\b(defective|faulty|malfunction)/i, /(doesn'?t|does\s+not|won'?t|will\s+not)\s+(work|turn\s+on|charge|switch\s+on)/i, /stopped\s+working/i, /\bdead\b/i],
    fault: 'MERCHANT',
    condition: 'NOT_FUNCTIONAL',
  },
  {
    reason: 'NOT_AS_DESCRIBED',
    patterns: [/not\s+as\s+(described|advertised|pictured)/i, /looks?\s+nothing\s+like/i, /misleading/i, /not\s+what\s+i\s+expected/i],
    fault: 'MERCHANT',
    condition: 'OPENED_LIKE_NEW',
  },
  {
    reason: 'SIZE_FIT_ISSUE',
    patterns: [/too\s+(small|big|large|tight|loose)/i, /doesn'?t\s+fit/i, /wrong\s+size\b/i, /\bsizing\b/i],
    fault: 'UNDETERMINED',
    condition: 'NEW_UNOPENED',
  },
  {
    reason: 'ARRIVED_LATE',
    patterns: [/(arrived|came|delivered)\s+(late|too\s+late)/i, /took\s+too\s+long/i, /missed\s+(the\s+)?(deadline|birthday|christmas)/i],
    fault: 'CARRIER',
    condition: 'NEW_UNOPENED',
  },
  {
    reason: 'DUPLICATE_ORDER',
    patterns: [/duplicate/i, /ordered\s+(it\s+)?twice/i, /two\s+of\s+the\s+same/i],
    fault: 'CUSTOMER',
    condition: 'NEW_UNOPENED',
  },
  {
    reason: 'BETTER_PRICE_FOUND',
    patterns: [/cheaper\s+(elsewhere|somewhere)/i, /found\s+it\s+for\s+less/i, /better\s+price/i],
    fault: 'CUSTOMER',
    condition: 'NEW_UNOPENED',
  },
  {
    reason: 'CHANGE_OF_MIND',
    patterns: [/changed?\s+my\s+mind/i, /don'?t\s+(want|need)\s+it/i, /no\s+longer\s+need/i, /decided\s+against/i],
    fault: 'CUSTOMER',
    condition: 'NEW_UNOPENED',
  },
];

const OUTCOME_PATTERNS: { outcome: RequestedOutcome; patterns: RegExp[] }[] = [
  { outcome: 'REPLACEMENT', patterns: [/\breplacement\b/i, /replace\s+it/i, /send\s+(me\s+)?a\s+new/i, /another\s+one/i] },
  { outcome: 'EXCHANGE', patterns: [/\bexchange\b/i, /swap\s+it/i, /different\s+size/i] },
  { outcome: 'REFUND', patterns: [/\brefund\b/i, /money\s+back/i, /reimburse/i] },
  { outcome: 'STORE_CREDIT', patterns: [/store\s+credit/i, /\bvoucher\b/i, /\bcredit\b/i] },
  { outcome: 'REPAIR', patterns: [/\brepair\b/i, /\bfix(ed)?\b/i, /under\s+warranty/i] },
];

/** Product nouns mapped to the SKUs in the fixture catalogue. */
const PRODUCT_KEYWORDS: { keywords: string[]; sku: string; mention: string }[] = [
  { keywords: ['smartwatch', 'smart watch', 'watch', 'orbit'], sku: 'SKU-SW-ORBIT-42', mention: 'smartwatch' },
  { keywords: ['earbuds', 'earphones', 'headphones', 'kopfhörer', 'nova'], sku: 'SKU-EB-NOVA-PRO', mention: 'earbuds' },
  { keywords: ['phone case', 'case', 'shield'], sku: 'SKU-PC-SHIELD-12', mention: 'phone case' },
  { keywords: ['coffee', 'beans', 'nebula'], sku: 'SKU-GR-NEBULA-1KG', mention: 'coffee beans' },
  { keywords: ['t-shirt', 'tshirt', 'tee', 'shirt'], sku: 'SKU-AP-FLEX-TEE', mention: 't-shirt' },
  { keywords: ['lamp', 'lumen', 'desk lamp'], sku: 'SKU-HM-LUMEN-CLR', mention: 'desk lamp' },
  { keywords: ['tv', 'television', 'orion'], sku: 'SKU-TV-ORION-55', mention: 'TV' },
];

/* -------------------------------------------------------------------------- */
/* Parser                                                                      */
/* -------------------------------------------------------------------------- */

export interface ParseOptions {
  /** Known customer, when the request comes from an authenticated session. */
  customerId?: string;
  /** Explicit order/item, when the customer picked from their order list —
   *  this bypasses fuzzy resolution entirely and is the happy path in the UI. */
  orderId?: string;
  orderItemId?: string;
  channel?: ReturnIntent['channel'];
  hasPhotoEvidence?: boolean;
}

export interface ParseResult {
  intent: ReturnIntent;
  /** Resolved entities, or nulls when resolution failed. */
  customer: Customer | null;
  order: Order | null;
  orderItem: OrderItem | null;
}

export function parseIntent(rawText: string, options: ParseOptions = {}): ParseResult {
  const text = rawText.trim();
  const entities: ReturnIntent['extractedEntities'] = [];
  const missingFields: string[] = [];

  /* -- 1. reason, fault, condition --------------------------------------- */
  // TODO(owner): an LLM call would replace this block. Keep the same outputs.
  let reason: ReturnReason = 'UNKNOWN';
  let fault: FaultAttribution = 'UNDETERMINED';
  let condition: ItemCondition = 'UNKNOWN';

  for (const entry of REASON_PATTERNS) {
    const hit = entry.patterns.find((p) => p.test(text));
    if (hit) {
      reason = entry.reason;
      fault = entry.fault;
      condition = entry.condition;
      entities.push({ type: 'reason', value: entry.reason, sourceText: text.match(hit)?.[0] ?? '' });
      break;
    }
  }
  if (reason === 'UNKNOWN') missingFields.push('reason');

  /* -- 2. requested outcome ---------------------------------------------- */
  let requestedOutcome: RequestedOutcome = 'UNSPECIFIED';
  for (const entry of OUTCOME_PATTERNS) {
    const hit = entry.patterns.find((p) => p.test(text));
    if (hit) {
      requestedOutcome = entry.outcome;
      entities.push({ type: 'requestedOutcome', value: entry.outcome, sourceText: text.match(hit)?.[0] ?? '' });
      break;
    }
  }
  // "I'd like a return" alone is a refund-ish signal but not explicit — leave
  // it UNSPECIFIED and let the Resolution Agent decide what is best.

  /* -- 3. relative time phrase ------------------------------------------- */
  let purchaseAgeDaysStated: number | null = null;
  const agePatterns: [RegExp, (n: number) => number][] = [
    [/(\d+)\s*days?\s+ago/i, (n) => n],
    [/(\d+)\s*weeks?\s+ago/i, (n) => n * 7],
    [/(\d+)\s*months?\s+ago/i, (n) => n * 30],
  ];
  for (const [pattern, toDays] of agePatterns) {
    const m = text.match(pattern);
    if (m?.[1]) {
      purchaseAgeDaysStated = toDays(Number.parseInt(m[1], 10));
      entities.push({ type: 'purchaseAge', value: String(purchaseAgeDaysStated), sourceText: m[0] });
      break;
    }
  }
  if (/last\s+week/i.test(text) && purchaseAgeDaysStated === null) purchaseAgeDaysStated = 7;
  if (/yesterday/i.test(text) && purchaseAgeDaysStated === null) purchaseAgeDaysStated = 1;

  /* -- 4. product mention ------------------------------------------------ */
  const lower = text.toLowerCase();
  let sku: string | null = null;
  let productMention: string | null = null;
  for (const entry of PRODUCT_KEYWORDS) {
    const kw = entry.keywords.find((k) => lower.includes(k));
    if (kw) {
      sku = entry.sku;
      productMention = entry.mention;
      entities.push({ type: 'product', value: entry.sku, sourceText: kw });
      break;
    }
  }

  /* -- 5. quantity -------------------------------------------------------- */
  let quantity = 1;
  const qtyMatch = text.match(/\b(both|two|2|three|3|all)\b/i);
  if (qtyMatch) {
    const word = qtyMatch[1]!.toLowerCase();
    quantity = word === 'both' || word === 'two' || word === '2' ? 2 : word === 'three' || word === '3' ? 3 : 2;
    entities.push({ type: 'quantity', value: String(quantity), sourceText: qtyMatch[0] });
  }

  /* -- 6. entity resolution ---------------------------------------------- */
  const resolved = resolveOrder({
    customerId: options.customerId ?? null,
    orderId: options.orderId ?? null,
    orderItemId: options.orderItemId ?? null,
    sku,
    purchaseAgeDaysStated,
  });

  if (!resolved.customer) missingFields.push('customerId');
  if (!resolved.order) missingFields.push('orderId');
  if (!resolved.orderItem) missingFields.push('orderItemId');

  /* -- 7. confidence ------------------------------------------------------ */
  // Weighted: knowing WHAT and WHY matters more than knowing the exact wording.
  let confidence = 0.2;
  if (resolved.order) confidence += 0.3;
  if (resolved.orderItem) confidence += 0.2;
  if (reason !== 'UNKNOWN') confidence += 0.25;
  if (requestedOutcome !== 'UNSPECIFIED') confidence += 0.05;
  confidence = Math.min(1, Math.round(confidence * 100) / 100);

  const intent: ReturnIntent = {
    rawText: text,
    channel: options.channel ?? 'IN_APP',
    customerId: resolved.customer?.customerId ?? null,
    orderId: resolved.order?.orderId ?? null,
    orderItemId: resolved.orderItem?.orderItemId ?? null,
    sku: resolved.orderItem?.sku ?? sku,
    productMention,
    quantity: Math.min(quantity, resolved.orderItem?.quantity ?? quantity),
    reason,
    faultAttribution: fault,
    reportedCondition: condition,
    requestedOutcome,
    purchaseAgeDaysStated,
    parseConfidence: confidence,
    missingFields,
    extractedEntities: entities,
    regionCode: resolved.customer?.regionCode ?? null,
    hasPhotoEvidence: options.hasPhotoEvidence ?? false,
    parsedAt: clock.nowIso(),
  };

  return { intent, customer: resolved.customer, order: resolved.order, orderItem: resolved.orderItem };
}

/* -------------------------------------------------------------------------- */
/* Entity resolution                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Resolves which order line the customer means.
 * Precedence: explicit IDs > (customer + SKU) > (customer + stated age) >
 * (SKU across all customers, demo convenience) > nothing.
 */
function resolveOrder(input: {
  customerId: string | null;
  orderId: string | null;
  orderItemId: string | null;
  sku: string | null;
  purchaseAgeDaysStated: number | null;
}): { customer: Customer | null; order: Order | null; orderItem: OrderItem | null } {
  // Explicit IDs — the UI's normal path.
  if (input.orderId) {
    const order = db.orders.get(input.orderId) ?? null;
    if (order) {
      const item =
        (input.orderItemId ? order.items.find((i) => i.orderItemId === input.orderItemId) : undefined) ??
        (input.sku ? order.items.find((i) => i.sku === input.sku) : undefined) ??
        order.items[0] ??
        null;
      return { customer: db.customers.get(order.customerId) ?? null, order, orderItem: item };
    }
  }

  const customer = input.customerId ? (db.customers.get(input.customerId) ?? null) : null;

  // Candidate orders, most recent first.
  const candidates = (customer ? db.orders.find((o) => o.customerId === customer.customerId) : db.orders.all())
    .filter((o) => o.status === 'DELIVERED' || o.status === 'PARTIALLY_RETURNED')
    .sort((a, b) => (b.deliveredAt ?? b.placedAt).localeCompare(a.deliveredAt ?? a.placedAt));

  // Match on SKU, preferring the order whose age is closest to what was stated.
  if (input.sku) {
    const withSku = candidates.filter((o) => o.items.some((i) => i.sku === input.sku));
    const best =
      input.purchaseAgeDaysStated !== null
        ? [...withSku].sort(
            (a, b) =>
              Math.abs(daysBetween(a.placedAt) - input.purchaseAgeDaysStated!) -
              Math.abs(daysBetween(b.placedAt) - input.purchaseAgeDaysStated!),
          )[0]
        : withSku[0];

    if (best) {
      return {
        customer: customer ?? db.customers.get(best.customerId) ?? null,
        order: best,
        orderItem: best.items.find((i) => i.sku === input.sku) ?? null,
      };
    }
  }

  // Fall back to the customer's most recent delivered order.
  const fallback = customer ? candidates[0] : undefined;
  if (fallback) {
    return { customer, order: fallback, orderItem: fallback.items[0] ?? null };
  }

  return { customer, order: null, orderItem: null };
}

/** Parse confidence below this triggers a clarifying question instead of a run. */
export const MIN_PARSE_CONFIDENCE = 0.5;

/** The question to ask when parsing was too uncertain to proceed. */
export function buildClarifyingQuestion(intent: ReturnIntent): string {
  if (intent.missingFields.includes('orderId')) {
    return "I couldn't find that order. Could you tell me which order it was, or pick it from your recent orders?";
  }
  if (intent.missingFields.includes('reason')) {
    return 'Could you tell me a bit more about what went wrong — did it arrive damaged, is it faulty, or have you changed your mind?';
  }
  return 'Could you give me a little more detail so I can find the right order?';
}
