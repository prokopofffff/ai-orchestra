import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Markdown } from "../components/Markdown";

describe("Markdown", () => {
  it("renders ## headings as real h2 elements", () => {
    render(<Markdown>{"## Plan summary"}</Markdown>);
    const h = screen.getByRole("heading", { level: 2 });
    expect(h).toHaveTextContent("Plan summary");
  });

  it("renders **bold** as <strong>", () => {
    render(<Markdown>{"Status: **shipped**"}</Markdown>);
    expect(screen.getByText("shipped").tagName).toBe("STRONG");
  });

  it("renders bullet lists", () => {
    render(<Markdown>{"- one\n- two\n- three"}</Markdown>);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("one");
  });

  it("renders GFM tables", () => {
    const md = "| # | Task | Role |\n|---|------|------|\n| 1 | Build | frontend |";
    render(<Markdown>{md}</Markdown>);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Task" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Build" })).toBeInTheDocument();
  });

  it("renders inline code", () => {
    render(<Markdown>{"Use `task_create` for that."}</Markdown>);
    expect(screen.getByText("task_create").tagName).toBe("CODE");
  });

  it("renders fenced code blocks", () => {
    render(<Markdown>{"```ts\nconst x = 1;\n```"}</Markdown>);
    expect(screen.getByText(/const x = 1;/)).toBeInTheDocument();
  });
});
