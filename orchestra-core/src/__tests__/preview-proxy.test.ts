import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { rewriteSetCookie, rewriteLocation, baseInjector } from "../preview-proxy";

describe("preview-proxy rewrites", () => {
  describe("rewriteSetCookie", () => {
    it("rewrites Path=/ to the preview prefix", () => {
      const out = rewriteSetCookie(["sid=abc; Path=/; HttpOnly"], "/preview/p1");
      expect(out).toEqual(["sid=abc; Path=/preview/p1; HttpOnly"]);
    });

    it("leaves non-root paths alone", () => {
      const out = rewriteSetCookie(["x=y; Path=/api; HttpOnly"], "/preview/p1");
      expect(out).toEqual(["x=y; Path=/api; HttpOnly"]);
    });

    it("leaves cookies without a Path attribute alone", () => {
      const out = rewriteSetCookie(["x=y"], "/preview/p1");
      expect(out).toEqual(["x=y"]);
    });

    it("handles multiple Set-Cookie headers", () => {
      const out = rewriteSetCookie(
        ["a=1; Path=/", "b=2; Path=/admin", "c=3; Path=/"],
        "/preview/p1",
      );
      expect(out).toEqual([
        "a=1; Path=/preview/p1",
        "b=2; Path=/admin",
        "c=3; Path=/preview/p1",
      ]);
    });

    it("returns undefined when input is undefined", () => {
      expect(rewriteSetCookie(undefined, "/preview/p1")).toBeUndefined();
    });

    it("Path match is case-insensitive (defensive against weird upstreams)", () => {
      const out = rewriteSetCookie(["x=y; path=/; HttpOnly"], "/preview/p1");
      expect(out).toEqual(["x=y; path=/preview/p1; HttpOnly"]);
    });
  });

  describe("rewriteLocation", () => {
    it("prefixes root-relative Location with the preview path", () => {
      expect(rewriteLocation("/login", "/preview/p1")).toBe("/preview/p1/login");
    });

    it("leaves full URLs alone", () => {
      expect(rewriteLocation("https://elsewhere.example.com/x", "/preview/p1")).toBe(
        "https://elsewhere.example.com/x",
      );
    });

    it("leaves protocol-relative URLs alone (//cdn.x/y)", () => {
      expect(rewriteLocation("//cdn.example.com/y", "/preview/p1")).toBe("//cdn.example.com/y");
    });

    it("leaves relative URLs alone (./next)", () => {
      expect(rewriteLocation("./next", "/preview/p1")).toBe("./next");
    });

    it("returns undefined when input is undefined", () => {
      expect(rewriteLocation(undefined, "/preview/p1")).toBeUndefined();
    });
  });

  describe("baseInjector", () => {
    async function pipe(input: string, prefix: string): Promise<string> {
      const t = baseInjector(prefix);
      Readable.from([Buffer.from(input)]).pipe(t);
      const chunks: Buffer[] = [];
      for await (const c of t) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString("utf-8");
    }

    it("injects <base href> right after <head>", async () => {
      const out = await pipe(
        "<!doctype html><html><head><title>x</title></head><body>hi</body></html>",
        "/preview/p1",
      );
      expect(out).toBe(
        '<!doctype html><html><head><base href="/preview/p1/"><title>x</title></head><body>hi</body></html>',
      );
    });

    it("handles <head> with attributes (<head class=\"x\">)", async () => {
      const out = await pipe(
        '<html><head class="x" data-y><body>hi</body></head></html>',
        "/preview/p1",
      );
      expect(out).toContain('<head class="x" data-y><base href="/preview/p1/">');
    });

    it("only injects once", async () => {
      const out = await pipe("<html><head></head><head></head></html>", "/preview/p1");
      expect((out.match(/<base /g) ?? []).length).toBe(1);
    });

    it("passes through non-HTML-looking content without breaking", async () => {
      const json = '{"hello":"world"}';
      const out = await pipe(json, "/preview/p1");
      expect(out).toBe(json);
    });
  });
});
