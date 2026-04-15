import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Chat } from "../components/Chat";
import * as api from "../api";
import type { Message } from "../types";
import { renderWithQuery } from "./test-utils";

vi.mock("../api");

function msg(overrides: Partial<Message>): Message {
  return {
    id: "m-" + Math.random().toString(36).slice(2, 10),
    conversationId: "c1",
    fromRole: "user",
    source: "dashboard",
    text: "hi",
    metadata: {},
    createdAt: new Date("2026-04-14T10:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
});

describe("Chat", () => {
  it("renders every message in the list with role-specific class", async () => {
    vi.mocked(api.fetchMessages).mockResolvedValue([
      msg({ fromRole: "user",      text: "Hello" }),
      msg({ fromRole: "tech-lead", text: "Hi back" }),
      msg({ fromRole: "system",    text: "Task created" }),
    ]);
    renderWithQuery(<Chat projectId="p1" />);

    const user = await screen.findByText("Hello");
    const tl = await screen.findByText("Hi back");
    const sys = await screen.findByText("Task created");
    expect(user.closest(".chat-msg")!.classList.contains("msg-user")).toBe(true);
    expect(tl.closest(".chat-msg")!.classList.contains("msg-agent")).toBe(true);
    expect(sys.closest(".chat-msg")!.classList.contains("msg-system")).toBe(true);
  });

  it("shows 'You' / 'Tech Lead' / 'System' author labels", async () => {
    vi.mocked(api.fetchMessages).mockResolvedValue([
      msg({ fromRole: "user" }),
      msg({ fromRole: "tech-lead" }),
      msg({ fromRole: "system" }),
    ]);
    renderWithQuery(<Chat projectId="p1" />);
    await screen.findByText("You");
    expect(screen.getByText("Tech Lead")).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();
  });

  it("sends the input on Send click and clears it", async () => {
    vi.mocked(api.fetchMessages).mockResolvedValue([]);
    vi.mocked(api.sendMessage).mockResolvedValue(msg({ text: "new msg" }));
    const user = userEvent.setup();
    renderWithQuery(<Chat projectId="p1" />);

    const input = await screen.findByPlaceholderText(/Message Tech Lead/);
    await user.type(input, "new msg");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith("p1", "new msg"));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
  });

  it("sends on Enter keypress", async () => {
    vi.mocked(api.fetchMessages).mockResolvedValue([]);
    vi.mocked(api.sendMessage).mockResolvedValue(msg({ text: "via enter" }));
    const user = userEvent.setup();
    renderWithQuery(<Chat projectId="p1" />);

    const input = await screen.findByPlaceholderText(/Message Tech Lead/);
    await user.type(input, "via enter{Enter}");

    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith("p1", "via enter"));
  });

  it("does not send when the input is whitespace-only", async () => {
    vi.mocked(api.fetchMessages).mockResolvedValue([]);
    const user = userEvent.setup();
    renderWithQuery(<Chat projectId="p1" />);

    const input = await screen.findByPlaceholderText(/Message Tech Lead/);
    await user.type(input, "   ");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
