import { z } from "zod";

/** Convert snake_case DB row to camelCase and validate with Zod schema */
export function parseRow<T extends z.ZodTypeAny>(schema: T, row: Record<string, unknown>): z.infer<T> {
  const camel: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    camel[snakeToCamel(key)] = value;
  }
  return schema.parse(camel);
}

/** Parse array of rows */
export function parseRows<T extends z.ZodTypeAny>(schema: T, rows: Record<string, unknown>[]): z.infer<T>[] {
  return rows.map((row) => parseRow(schema, row));
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Convert camelCase to snake_case for DB queries */
export function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
