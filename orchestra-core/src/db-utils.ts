import { z } from "zod";

/**
 * Convert snake_case DB column names to camelCase.
 */
function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Transform a DB row (snake_case keys) into a camelCase object
 * and validate it against a Zod schema.
 */
export function parseRow<T extends z.ZodTypeAny>(
  schema: T,
  row: Record<string, unknown>
): z.infer<T> {
  const camelCased: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    camelCased[snakeToCamel(key)] = value;
  }
  return schema.parse(camelCased);
}

/**
 * Transform an array of DB rows and validate each against a Zod schema.
 */
export function parseRows<T extends z.ZodTypeAny>(
  schema: T,
  rows: Record<string, unknown>[]
): z.infer<T>[] {
  return rows.map((row) => parseRow(schema, row));
}
