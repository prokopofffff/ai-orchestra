import { describe, it, expect } from "vitest";
import { checkFileScope, checkFilesScope, formatViolations, getScopeRules } from "../scope-check.js";

describe("scope-check", () => {
  describe("frontend", () => {
    it("allows src/frontend/ files", () => {
      expect(checkFileScope("frontend", "src/frontend/App.tsx")).toBeNull();
      expect(checkFileScope("frontend", "src/frontend/components/Header.tsx")).toBeNull();
    });

    it("allows src/shared/types/ files", () => {
      expect(checkFileScope("frontend", "src/shared/types/api.ts")).toBeNull();
    });

    it("allows public/ files", () => {
      expect(checkFileScope("frontend", "public/index.html")).toBeNull();
    });

    it("denies src/backend/ files", () => {
      const v = checkFileScope("frontend", "src/backend/server.ts");
      expect(v).not.toBeNull();
      expect(v!.reason).toBe("denied");
    });

    it("denies src/api/ files", () => {
      const v = checkFileScope("frontend", "src/api/routes.ts");
      expect(v).not.toBeNull();
      expect(v!.reason).toBe("denied");
    });

    it("denies database/ files", () => {
      const v = checkFileScope("frontend", "database/migrations/001.sql");
      expect(v).not.toBeNull();
      expect(v!.reason).toBe("denied");
    });

    it("denies root-level unknown files", () => {
      const v = checkFileScope("frontend", "package.json");
      expect(v).not.toBeNull();
      expect(v!.reason).toBe("not_allowed");
    });
  });

  describe("backend", () => {
    it("allows src/backend/ files", () => {
      expect(checkFileScope("backend", "src/backend/index.ts")).toBeNull();
    });

    it("allows src/api/ files", () => {
      expect(checkFileScope("backend", "src/api/routes.ts")).toBeNull();
    });

    it("allows database/ files", () => {
      expect(checkFileScope("backend", "database/migrations/001.sql")).toBeNull();
    });

    it("allows src/shared/types/", () => {
      expect(checkFileScope("backend", "src/shared/types/models.ts")).toBeNull();
    });

    it("denies src/frontend/", () => {
      const v = checkFileScope("backend", "src/frontend/App.tsx");
      expect(v).not.toBeNull();
      expect(v!.reason).toBe("denied");
    });

    it("denies public/", () => {
      const v = checkFileScope("backend", "public/styles.css");
      expect(v).not.toBeNull();
      expect(v!.reason).toBe("denied");
    });
  });

  describe("designer", () => {
    it("allows design/ files", () => {
      expect(checkFileScope("designer", "design/homepage.pen")).toBeNull();
    });

    it("allows .pen files anywhere", () => {
      expect(checkFileScope("designer", "mockups/login.pen")).toBeNull();
    });

    it("allows STYLE.md", () => {
      expect(checkFileScope("designer", "STYLE.md")).toBeNull();
    });

    it("denies src/ files", () => {
      const v = checkFileScope("designer", "src/frontend/App.tsx");
      expect(v).not.toBeNull();
      expect(v!.reason).toBe("denied");
    });
  });

  describe("qa", () => {
    it("allows tests/ files", () => {
      expect(checkFileScope("qa", "tests/auth.test.ts")).toBeNull();
    });

    it("allows e2e/ files", () => {
      expect(checkFileScope("qa", "e2e/login.spec.ts")).toBeNull();
    });

    it("denies src/ files (can't modify source)", () => {
      const v = checkFileScope("qa", "src/backend/auth.ts");
      expect(v).not.toBeNull();
    });
  });

  describe("devops", () => {
    it("allows .github/ files", () => {
      expect(checkFileScope("devops", ".github/workflows/ci.yml")).toBeNull();
    });

    it("allows docker-compose.yml", () => {
      expect(checkFileScope("devops", "docker-compose.yml")).toBeNull();
    });

    it("allows Dockerfile", () => {
      expect(checkFileScope("devops", "Dockerfile")).toBeNull();
    });
  });

  describe("tech-lead", () => {
    it("allows everything", () => {
      expect(checkFileScope("tech-lead", "src/backend/auth.ts")).toBeNull();
      expect(checkFileScope("tech-lead", "src/frontend/App.tsx")).toBeNull();
      expect(checkFileScope("tech-lead", "CLAUDE.md")).toBeNull();
    });
  });

  describe("checkFilesScope", () => {
    it("returns all violations for multiple files", () => {
      const violations = checkFilesScope("frontend", [
        "src/frontend/App.tsx",
        "src/backend/server.ts",
        "src/api/routes.ts",
        "public/index.html",
      ]);
      expect(violations.length).toBe(2);
      expect(violations.map((v) => v.file)).toContain("src/backend/server.ts");
      expect(violations.map((v) => v.file)).toContain("src/api/routes.ts");
    });

    it("returns empty for all-valid files", () => {
      expect(checkFilesScope("backend", ["src/backend/a.ts", "src/api/b.ts"])).toEqual([]);
    });
  });

  describe("formatViolations", () => {
    it("formats violation messages", () => {
      const violations = checkFilesScope("frontend", ["src/backend/x.ts", "package.json"]);
      const msg = formatViolations("frontend", violations);
      expect(msg).toContain("Scope violations for frontend");
      expect(msg).toContain("src/backend/x.ts");
      expect(msg).toContain("denied");
    });

    it("returns empty string for no violations", () => {
      expect(formatViolations("frontend", [])).toBe("");
    });
  });

  describe("getScopeRules", () => {
    it("returns rules for role", () => {
      const rules = getScopeRules("frontend");
      expect(rules.allowed).toContain("src/frontend/**");
      expect(rules.denied).toContain("src/backend/**");
    });
  });
});
