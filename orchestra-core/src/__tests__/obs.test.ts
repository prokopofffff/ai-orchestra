import { describe, it, expect } from "vitest";
import { withContext, getContext } from "../obs";

describe("obs — withContext", () => {
  it("returns empty context when called outside a withContext run", () => {
    expect(getContext()).toEqual({});
  });

  it("makes context visible inside the callback", async () => {
    await withContext({ reqId: "abc" }, async () => {
      expect(getContext()).toMatchObject({ reqId: "abc" });
    });
  });

  it("reverts to outer context after the callback returns", async () => {
    await withContext({ reqId: "abc" }, async () => {
      // inside
    });
    expect(getContext()).toEqual({});
  });

  it("merges nested contexts (inner overrides outer keys)", async () => {
    await withContext({ reqId: "outer", projectId: "p1" }, async () => {
      expect(getContext()).toMatchObject({ reqId: "outer", projectId: "p1" });
      await withContext({ reqId: "inner", jobId: "j1" }, async () => {
        // reqId overridden, projectId inherited, jobId added
        expect(getContext()).toMatchObject({ reqId: "inner", projectId: "p1", jobId: "j1" });
      });
      // back to outer after inner exits — jobId is no longer in the context
      const outer = getContext();
      expect(outer).toMatchObject({ reqId: "outer", projectId: "p1" });
      expect(outer.jobId).toBeUndefined();
    });
  });

  it("propagates context across awaits inside the callback", async () => {
    await withContext({ jobId: "x" }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(getContext().jobId).toBe("x");
    });
  });

  it("isolates context between concurrent withContext calls", async () => {
    const observed: string[] = [];
    await Promise.all([
      withContext({ reqId: "A" }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        observed.push(getContext().reqId as string);
      }),
      withContext({ reqId: "B" }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        observed.push(getContext().reqId as string);
      }),
    ]);
    expect(observed.sort()).toEqual(["A", "B"]);
  });
});
