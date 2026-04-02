import { describe, it, expect } from "vitest";
import {
  validateSignal,
  validateStateTransition,
  getTargetState,
  getValidTransitions,
  type SignalPayload,
} from "../flow-guard.js";

const signal = (overrides: Partial<SignalPayload> = {}): SignalPayload => ({
  from: "tech-lead",
  to: "backend",
  action: "assign_dev",
  projectId: "00000000-0000-0000-0000-000000000000",
  ...overrides,
});

describe("flow-guard", () => {
  // ─── Route Validation ───

  describe("validateSignal — routes", () => {
    it("allows tech-lead → backend", () => {
      expect(validateSignal(signal())).toEqual({ allowed: true });
    });

    it("allows tech-lead → all valid targets", () => {
      for (const to of ["designer", "frontend", "backend", "qa", "devops", "user"]) {
        const result = validateSignal(signal({ to, action: "notify" }));
        expect(result.allowed).toBe(true);
      }
    });

    it("allows backend → tech-lead", () => {
      expect(validateSignal(signal({ from: "backend", to: "tech-lead", action: "question" }))).toEqual({ allowed: true });
    });

    it("allows backend → qa", () => {
      expect(validateSignal(signal({ from: "backend", to: "qa", action: "pr_created" }))).toEqual({ allowed: true });
    });

    it("rejects frontend → backend (dev-to-dev)", () => {
      const result = validateSignal(signal({ from: "frontend", to: "backend", action: "question" }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Route not allowed");
    });

    it("rejects designer → frontend (designer-to-dev)", () => {
      const result = validateSignal(signal({ from: "designer", to: "frontend", action: "notify" }));
      expect(result.allowed).toBe(false);
    });

    it("rejects qa → backend (qa-to-dev)", () => {
      const result = validateSignal(signal({ from: "qa", to: "backend", action: "notify" }));
      expect(result.allowed).toBe(false);
    });

    it("rejects unknown sender role", () => {
      const result = validateSignal(signal({ from: "hacker" }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Unknown sender role");
    });

    it("allows system → tech-lead", () => {
      expect(validateSignal(signal({ from: "system", to: "tech-lead", action: "task_unblocked" }))).toEqual({ allowed: true });
    });
  });

  // ─── Action Validation ───

  describe("validateSignal — actions", () => {
    it("allows tech-lead: assign_dev", () => {
      expect(validateSignal(signal({ action: "assign_dev" })).allowed).toBe(true);
    });

    it("allows tech-lead: create_design, deploy, pr_approved", () => {
      for (const action of ["create_design", "deploy", "pr_approved", "setup_cicd"]) {
        expect(validateSignal(signal({ to: "designer", action })).allowed ||
               validateSignal(signal({ to: "devops", action })).allowed).toBe(true);
      }
    });

    it("rejects frontend: deploy", () => {
      const result = validateSignal(signal({ from: "frontend", to: "tech-lead", action: "deploy" }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Action not allowed");
    });

    it("rejects backend: assign_dev", () => {
      const result = validateSignal(signal({ from: "backend", to: "tech-lead", action: "assign_dev" }));
      expect(result.allowed).toBe(false);
    });

    it("rejects qa: pr_approved", () => {
      const result = validateSignal(signal({ from: "qa", to: "tech-lead", action: "pr_approved" }));
      expect(result.allowed).toBe(false);
    });

    it("allows all roles: escalate", () => {
      for (const from of ["tech-lead", "designer", "frontend", "backend", "qa", "devops"]) {
        const result = validateSignal(signal({ from, to: "user", action: "escalate" }));
        expect(result.allowed).toBe(true);
      }
    });

    it("allows qa: tests_passed and tests_failed", () => {
      expect(validateSignal(signal({ from: "qa", to: "tech-lead", action: "tests_passed" })).allowed).toBe(true);
      expect(validateSignal(signal({ from: "qa", to: "tech-lead", action: "tests_failed" })).allowed).toBe(true);
    });
  });

  // ─── State Machine ───

  describe("validateStateTransition", () => {
    it("allows new → described (no action mapping, always allowed)", () => {
      // No action maps to "described", so any action without mapping passes
      expect(validateStateTransition("new", "question").allowed).toBe(true);
    });

    it("allows described → in_development via assign_dev", () => {
      expect(validateStateTransition("described", "assign_dev").allowed).toBe(true);
    });

    it("allows described → designing via create_design", () => {
      expect(validateStateTransition("described", "create_design").allowed).toBe(true);
    });

    it("allows designing → design_ready via design_ready", () => {
      expect(validateStateTransition("designing", "design_ready").allowed).toBe(true);
    });

    it("allows in_development → pr_created via pr_created", () => {
      expect(validateStateTransition("in_development", "pr_created").allowed).toBe(true);
    });

    it("allows in_testing → tested via tests_passed", () => {
      expect(validateStateTransition("in_testing", "tests_passed").allowed).toBe(true);
    });

    it("allows in_review → approved via pr_approved", () => {
      expect(validateStateTransition("in_review", "pr_approved").allowed).toBe(true);
    });

    it("allows in_review → in_development via pr_changes_requested", () => {
      expect(validateStateTransition("in_review", "pr_changes_requested").allowed).toBe(true);
    });

    it("rejects new → in_development via assign_dev", () => {
      const result = validateStateTransition("new", "assign_dev");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Invalid transition: new → in_development");
    });

    it("rejects new → pr_created via pr_created (must go through development)", () => {
      const result = validateStateTransition("new", "pr_created");
      expect(result.allowed).toBe(false);
    });

    it("rejects designing → in_development via assign_dev (must finish design first)", () => {
      const result = validateStateTransition("designing", "assign_dev");
      expect(result.allowed).toBe(false);
    });

    it("allows idempotent transitions (same state → same state)", () => {
      expect(validateStateTransition("in_development", "assign_dev").allowed).toBe(true);
      expect(validateStateTransition("designing", "create_design").allowed).toBe(true);
      expect(validateStateTransition("pr_created", "pr_created").allowed).toBe(true);
    });

    it("allows in_review → pr_created (re-submit after changes)", () => {
      expect(validateStateTransition("in_review", "pr_created").allowed).toBe(true);
    });

    it("allows actions without state mapping (question, notify)", () => {
      expect(validateStateTransition("new", "question").allowed).toBe(true);
      expect(validateStateTransition("in_development", "notify").allowed).toBe(true);
      expect(validateStateTransition("pr_created", "escalate").allowed).toBe(true);
    });

    it("rejects unknown state", () => {
      const result = validateStateTransition("nonexistent", "assign_dev");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Unknown state");
    });
  });

  // ─── Full lifecycle ───

  describe("full task lifecycle", () => {
    it("validates happy path: new → described → designing → design_ready → in_development → pr_created → in_testing → tested → in_review → approved", () => {
      // described → designing
      expect(validateStateTransition("described", "create_design").allowed).toBe(true);
      // designing → design_ready
      expect(validateStateTransition("designing", "design_ready").allowed).toBe(true);
      // design_ready → in_development
      expect(validateStateTransition("design_ready", "assign_dev").allowed).toBe(true);
      // in_development → pr_created
      expect(validateStateTransition("in_development", "pr_created").allowed).toBe(true);
      // pr_created → in_testing (no action mapping for this, tested via tests_passed from in_testing)
      // in_testing → tested
      expect(validateStateTransition("in_testing", "tests_passed").allowed).toBe(true);
      // tested → in_review (no action mapping)
      // in_review → approved
      expect(validateStateTransition("in_review", "pr_approved").allowed).toBe(true);
    });

    it("validates backend shortcut: described → in_development (skip design)", () => {
      expect(validateStateTransition("described", "assign_dev").allowed).toBe(true);
    });

    it("validates changes_requested loop: in_review → in_development → pr_created → ...", () => {
      expect(validateStateTransition("in_review", "pr_changes_requested").allowed).toBe(true);
      expect(validateStateTransition("in_development", "pr_created").allowed).toBe(true);
    });
  });

  // ─── Helpers ───

  describe("getTargetState", () => {
    it("returns target state for known actions", () => {
      expect(getTargetState("assign_dev")).toBe("in_development");
      expect(getTargetState("pr_created")).toBe("pr_created");
      expect(getTargetState("tests_passed")).toBe("tested");
      expect(getTargetState("pr_approved")).toBe("approved");
    });

    it("returns null for actions without state transitions", () => {
      expect(getTargetState("question")).toBeNull();
      expect(getTargetState("notify")).toBeNull();
      expect(getTargetState("escalate")).toBeNull();
    });
  });

  describe("getValidTransitions", () => {
    it("returns valid transitions for known states", () => {
      expect(getValidTransitions("new")).toEqual(["described"]);
      expect(getValidTransitions("described")).toEqual(["designing", "in_development"]);
      expect(getValidTransitions("in_review")).toEqual(["approved", "in_development", "pr_created"]);
    });

    it("returns empty array for terminal state", () => {
      expect(getValidTransitions("closed")).toEqual([]);
    });

    it("returns empty array for unknown state", () => {
      expect(getValidTransitions("nonexistent")).toEqual([]);
    });
  });
});
