import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parseRow, parseRows, camelToSnake } from "../db-utils.js";

describe("db-utils", () => {
  describe("parseRow", () => {
    const schema = z.object({
      id: z.string(),
      projectId: z.string(),
      createdAt: z.coerce.date(),
    });

    it("converts snake_case keys to camelCase", () => {
      const row = { id: "abc", project_id: "proj-1", created_at: "2026-01-01T00:00:00Z" };
      const result = parseRow(schema, row);
      expect(result.id).toBe("abc");
      expect(result.projectId).toBe("proj-1");
      expect(result.createdAt).toBeInstanceOf(Date);
    });

    it("throws on missing required fields", () => {
      const row = { id: "abc" };
      expect(() => parseRow(schema, row)).toThrow();
    });

    it("handles already camelCase keys", () => {
      const row = { id: "abc", projectId: "proj-1", createdAt: "2026-01-01T00:00:00Z" };
      const result = parseRow(schema, row);
      expect(result.projectId).toBe("proj-1");
    });
  });

  describe("parseRows", () => {
    const schema = z.object({ id: z.string(), name: z.string() });

    it("parses array of rows", () => {
      const rows = [
        { id: "1", name: "a" },
        { id: "2", name: "b" },
      ];
      const result = parseRows(schema, rows);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("a");
      expect(result[1].name).toBe("b");
    });

    it("returns empty array for empty input", () => {
      expect(parseRows(schema, [])).toEqual([]);
    });
  });

  describe("camelToSnake", () => {
    it("converts camelCase to snake_case", () => {
      expect(camelToSnake("projectId")).toBe("project_id");
      expect(camelToSnake("createdAt")).toBe("created_at");
      expect(camelToSnake("assigneeRole")).toBe("assignee_role");
    });

    it("leaves already snake_case unchanged", () => {
      expect(camelToSnake("id")).toBe("id");
      expect(camelToSnake("name")).toBe("name");
    });

    it("handles multiple uppercase letters", () => {
      expect(camelToSnake("blockedByTaskId")).toBe("blocked_by_task_id");
    });
  });
});
