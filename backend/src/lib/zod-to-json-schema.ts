/**
 * Zod -> JSON Schema.
 *
 * Thin wrapper over Zod 4's NATIVE `z.toJSONSchema()`. This file used to contain
 * a hand-rolled converter (necessary on Zod 3); Zod 4 ships a complete, spec-
 * correct implementation, so we delegate. Keeping the wrapper gives us one place
 * to pin the options that matter and one import path for callers.
 *
 * TWO CONSUMERS, TWO MODES:
 *
 *   'output' (strict)  — used to CONSTRAIN the model via the Agent SDK's
 *                        `outputFormat: { type: 'json_schema', schema }`.
 *                        Emits `additionalProperties: false` and marks every
 *                        field (including defaulted ones) as required, so the
 *                        model cannot omit or invent fields. This is what makes
 *                        the structured output genuinely forced rather than
 *                        merely requested.
 *
 *   'input'  (lenient) — used for DOCUMENTATION (`GET /agents/:id/contract`).
 *                        Defaulted fields are optional, matching what a caller
 *                        actually has to supply.
 */
import { z, type ZodType } from 'zod';

export type JsonSchema = Record<string, unknown>;

export interface ToJsonSchemaOptions {
  /**
   * 'output' = strict (constrain a model). 'input' = lenient (document a caller).
   * Defaults to 'output'.
   */
  io?: 'input' | 'output';
  /** Strip the `$schema` key. The Agent SDK does not need it. */
  omitSchemaKeyword?: boolean;
}

/**
 * Converts a Zod schema to JSON Schema.
 *
 * `unrepresentable: 'any'` keeps this from throwing on constructs with no JSON
 * Schema equivalent — a doc endpoint should degrade, not 500. `cycles: 'ref'`
 * handles any recursive schema via `$ref` rather than infinite recursion.
 */
export function zodToJsonSchema(schema: ZodType, options: ToJsonSchemaOptions = {}): JsonSchema {
  const { io = 'output', omitSchemaKeyword = false } = options;

  const result = z.toJSONSchema(schema, {
    io,
    unrepresentable: 'any',
    cycles: 'ref',
    reused: 'inline',
  }) as JsonSchema;

  if (omitSchemaKeyword) {
    const { $schema: _discard, ...rest } = result;
    return rest;
  }
  return result;
}

/**
 * The schema handed to the Agent SDK to force structured output.
 *
 * USES `io: 'input'`, WHICH IS DELIBERATE AND WAS LEARNED THE HARD WAY.
 *
 * `io: 'output'` looks stricter and is tempting: it marks every field required
 * and adds `additionalProperties: false`. But the model is the PRODUCER here —
 * its JSON is the INPUT to our Zod parser — so 'input' is the semantically
 * correct side. Defaults exist precisely so a producer need not restate them.
 *
 * It also matters practically: under 'output' the two largest contracts
 * (Communication, with fully-rendered message bodies, and Insights, with
 * evidence and action arrays) forced JSON big enough that the CLI failed with
 * `API Error: JSON Parse error: Unable to parse JSON string`. Making defaulted
 * fields optional removes that cliff.
 *
 * Nothing is lost in validation strength: types, enums, ranges and required
 * fields are still constrained at generation time, and every response is then
 * parsed by the same Zod schema, which rejects anything invalid and applies the
 * defaults the model omitted.
 */
export function toStrictJsonSchema(schema: ZodType): JsonSchema {
  return zodToJsonSchema(schema, { io: 'input', omitSchemaKeyword: true });
}

/** Convenience for docs and contract tests. */
export function describeSchema(name: string, schema: ZodType): { name: string; schema: JsonSchema } {
  return { name, schema: zodToJsonSchema(schema, { io: 'input' }) };
}

export { z };
