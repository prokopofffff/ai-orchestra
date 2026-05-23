import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fsp } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeResolve, globToRegExp } from "../references-api";

// Pure-helper tests — no database, no HTTP — verify the path-traversal +
// glob primitives that gate every reference read. Anything that needs the
// API surface (ACL, JWT, settings-lookup) is covered by integration tests
// against the running server.

let tmpRoot: string;
let outside: string;

beforeAll(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "refs-api-"));
  outside = await fsp.mkdtemp(path.join(os.tmpdir(), "refs-outside-"));
  await fsp.mkdir(path.join(tmpRoot, "src"));
  await fsp.writeFile(path.join(tmpRoot, "README.md"), "# hi\n");
  await fsp.writeFile(path.join(tmpRoot, "src", "index.ts"), "export {};\n");
  await fsp.writeFile(path.join(outside, "secret.txt"), "leaked\n");
});

afterAll(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
  await fsp.rm(outside, { recursive: true, force: true });
});

describe("safeResolve", () => {
  it("accepts a path inside the project root", () => {
    const r = safeResolve(tmpRoot, "src/index.ts");
    expect(r).toBe(path.join(tmpRoot, "src/index.ts"));
  });

  it("accepts an empty subpath (project root itself)", () => {
    const r = safeResolve(tmpRoot, "");
    expect(r).toBe(tmpRoot);
  });

  it("rejects `..` traversal", () => {
    expect(safeResolve(tmpRoot, "../etc/passwd")).toBeNull();
    expect(safeResolve(tmpRoot, "src/../../escape")).toBeNull();
  });

  it("rejects absolute paths", () => {
    expect(safeResolve(tmpRoot, "/etc/passwd")).toBeNull();
    expect(safeResolve(tmpRoot, path.join(tmpRoot, "src/index.ts"))).toBeNull();
  });

  it("rejects null-byte injection", () => {
    expect(safeResolve(tmpRoot, "src/index.ts\0/.bashrc")).toBeNull();
  });

  it("rejects a symlink whose target escapes the root", () => {
    const linkPath = path.join(tmpRoot, "escape-link");
    fs.symlinkSync(outside, linkPath);
    try {
      // `escape-link` itself canonicalizes to `outside`, which is not inside tmpRoot.
      expect(safeResolve(tmpRoot, "escape-link/secret.txt")).toBeNull();
    } finally {
      fs.unlinkSync(linkPath);
    }
  });

  it("accepts a symlink whose target stays inside the root", () => {
    const linkPath = path.join(tmpRoot, "inner-link");
    fs.symlinkSync(path.join(tmpRoot, "src"), linkPath);
    try {
      const r = safeResolve(tmpRoot, "inner-link/index.ts");
      expect(r).toBe(path.join(tmpRoot, "inner-link", "index.ts"));
    } finally {
      fs.unlinkSync(linkPath);
    }
  });
});

describe("globToRegExp", () => {
  it("matches `*.ts` against same-segment file", () => {
    const re = globToRegExp("*.ts");
    expect(re.test("index.ts")).toBe(true);
    expect(re.test("a/b.ts")).toBe(false);
  });

  it("matches `src/**/*.ts` across nesting", () => {
    const re = globToRegExp("src/**/*.ts");
    expect(re.test("src/index.ts")).toBe(true);
    expect(re.test("src/a/b/c.ts")).toBe(true);
    expect(re.test("lib/index.ts")).toBe(false);
  });

  it("escapes regex metacharacters in literal segments", () => {
    const re = globToRegExp("README.md");
    expect(re.test("README.md")).toBe(true);
    expect(re.test("READMExmd")).toBe(false); // would match if "." weren't escaped
  });

  it("supports `?` for a single-char wildcard within a segment", () => {
    const re = globToRegExp("v?.ts");
    expect(re.test("v1.ts")).toBe(true);
    expect(re.test("v12.ts")).toBe(false);
  });
});
