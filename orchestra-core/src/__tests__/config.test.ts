import { describe, it, expect } from "vitest";
import { configSchema, getModelForRole } from "../config";

describe("config", () => {
  describe("configSchema", () => {
    it("parses valid config with all fields", () => {
      const result = configSchema.parse({
        databaseUrl: "postgres://localhost:5432/test",
        port: 4000,
        claudeAuth: "api",
        claudeApiKey: "sk-xxx",
        modelTechLead: "opus",
        modelBackend: "haiku",
        jwtSecret: "test-test-test-test-test-test",
      });
      expect(result.port).toBe(4000);
      expect(result.claudeAuth).toBe("api");
      expect(result.modelTechLead).toBe("opus");
      expect(result.modelBackend).toBe("haiku");
    });

    it("applies defaults for optional fields", () => {
      const result = configSchema.parse({
        databaseUrl: "postgres://localhost:5432/test",
        jwtSecret: "test-test-test-test-test-test",
      });
      expect(result.port).toBe(3000);
      expect(result.nodeEnv).toBe("development");
      expect(result.claudeAuth).toBe("max");
      expect(result.githubDefaultBranch).toBe("main");
      expect(result.modelTechLead).toBe("opus");
      expect(result.modelDesigner).toBe("sonnet");
      expect(result.modelFrontend).toBe("sonnet");
      expect(result.modelBackend).toBe("sonnet");
      expect(result.modelQa).toBe("sonnet");
      expect(result.modelDevops).toBe("sonnet");
    });

    it("rejects missing databaseUrl", () => {
      expect(() => configSchema.parse({})).toThrow();
    });

    it("rejects invalid databaseUrl", () => {
      expect(() => configSchema.parse({
        databaseUrl: "not-a-url",
        jwtSecret: "test-test-test-test-test-test",
      })).toThrow();
    });

    it("rejects invalid model name", () => {
      expect(() =>
        configSchema.parse({
          databaseUrl: "postgres://localhost/test",
          modelTechLead: "gpt-4",
          jwtSecret: "test-test-test-test-test-test",
        })
      ).toThrow();
    });

    it("coerces port from string", () => {
      const result = configSchema.parse({
        databaseUrl: "postgres://localhost:5432/test",
        port: "8080",
        jwtSecret: "test-test-test-test-test-test",
      });
      expect(result.port).toBe(8080);
    });
  });

  describe("getModelForRole", () => {
    const baseConfig = configSchema.parse({
      databaseUrl: "postgres://localhost:5432/test",
      modelTechLead: "opus",
      modelFrontend: "sonnet",
      modelBackend: "haiku",
        jwtSecret: "test-test-test-test-test-test",
      });

    it("returns global config model for role", () => {
      expect(getModelForRole(baseConfig, "tech-lead")).toBe("opus");
      expect(getModelForRole(baseConfig, "frontend")).toBe("sonnet");
      expect(getModelForRole(baseConfig, "backend")).toBe("haiku");
    });

    it("returns per-project model when set", () => {
      const projectSettings = { models: { "tech-lead": "sonnet", backend: "opus" } };
      expect(getModelForRole(baseConfig, "tech-lead", projectSettings)).toBe("sonnet");
      expect(getModelForRole(baseConfig, "backend", projectSettings)).toBe("opus");
    });

    it("falls back to global when per-project not set for role", () => {
      const projectSettings = { models: { "tech-lead": "sonnet" } };
      expect(getModelForRole(baseConfig, "frontend", projectSettings)).toBe("sonnet");
    });

    it("falls back to global when projectSettings is undefined", () => {
      expect(getModelForRole(baseConfig, "tech-lead", undefined)).toBe("opus");
    });

    it("falls back to global when models key missing", () => {
      expect(getModelForRole(baseConfig, "tech-lead", { other: "value" })).toBe("opus");
    });
  });
});
