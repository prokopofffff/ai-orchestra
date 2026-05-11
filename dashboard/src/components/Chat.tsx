import { useState, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../api";
import type { Message } from "../types";
import { MoreVerticalIcon, SendIcon } from "./ui/Icon";

interface Props {
  projectId: string;
  /** Shown in the chat header. Defaults to "Conversation" so the component
   *  can be rendered without a surrounding layout in tests. */
  title?: string;
}

export function Chat({ projectId, title = "Conversation" }: Props) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const messagesKey = ["messages", projectId];
  const { data: messages } = useQuery({
    queryKey: messagesKey,
    queryFn: () => api.fetchMessages(projectId, 100),
    refetchInterval: 3_000,
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages?.length]);

  const handleSend = async () => {
    if (!input.trim()) return;
    await api.sendMessage(projectId, input);
    setInput("");
    await queryClient.invalidateQueries({ queryKey: messagesKey });
  };

  return (
    <div className="chat flex h-full flex-col bg-bg-page">
      <ChatHeader title={title} />

      <div className="chat-messages flex-1 min-h-0 overflow-y-auto px-8 py-6 flex flex-col gap-5 justify-end">
        {messages?.map((m) => <ChatMessage key={m.id} message={m} />)}
        <div ref={bottomRef} />
      </div>

      <div data-tour="chat.input" className="chat-input h-[72px] shrink-0 bg-bg-surface border-t border-border px-6 flex items-center gap-3">
        <select
          aria-label="Agent"
          className="h-10 bg-bg-input border border-border px-3 text-xs font-mono text-text-primary focus:outline-none focus:border-accent-blue"
          defaultValue="tech-lead"
        >
          <option value="tech-lead">tech-lead</option>
        </select>
        <input
          className="flex-1 h-10 bg-bg-input border border-border px-3.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-blue"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          placeholder="Message Tech Lead..."
        />
        <button
          aria-label="Send"
          onClick={handleSend}
          className="h-10 w-10 grid place-items-center bg-accent-blue text-white hover:bg-accent-blue/90 transition-colors"
        >
          <SendIcon size={16} />
        </button>
      </div>
    </div>
  );
}

function ChatHeader({ title }: { title: string }) {
  return (
    <header className="h-14 shrink-0 bg-bg-surface border-b border-border px-6 flex items-center gap-3">
      <div className="h-8 w-8 bg-accent-green text-white text-xs font-semibold grid place-items-center">
        TL
      </div>
      <div className="flex flex-col min-w-0">
        <span className="text-[13px] font-medium text-text-primary truncate">{title}</span>
        <span className="font-mono text-[11px] text-accent-green">running</span>
      </div>
      <button
        aria-label="More"
        className="ml-auto text-text-tertiary hover:text-text-primary"
      >
        <MoreVerticalIcon size={18} />
      </button>
    </header>
  );
}

function ChatMessage({ message }: { message: Message }) {
  const role = message.fromRole === "user"
    ? "user"
    : message.fromRole === "tech-lead"
      ? "agent"
      : "system";

  const label = role === "user" ? "You" : role === "agent" ? "Tech Lead" : "System";
  const time = new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  if (role === "system") {
    return (
      <div className="chat-msg msg-system self-center max-w-[70%] text-center">
        <div className="msg-header flex items-center justify-center gap-2 text-[11px] text-text-tertiary font-mono">
          <span className="msg-author">{label}</span>
          <span>·</span>
          <span>{message.source}</span>
          <span>·</span>
          <span>{time}</span>
        </div>
        <div className="msg-text text-xs italic text-text-tertiary whitespace-pre-wrap">
          {message.text}
        </div>
      </div>
    );
  }

  const align = role === "user" ? "self-end items-end" : "self-start items-start";

  return (
    <div className={`chat-msg msg-${role} flex max-w-[70%] flex-col gap-1 ${align}`}>
      <div className="msg-header flex items-center gap-2 text-[11px] text-text-tertiary font-mono">
        <span className="msg-author font-semibold text-text-secondary">{label}</span>
        <span>·</span>
        <span>{message.source}</span>
        <span>·</span>
        <span>{time}</span>
      </div>
      <div
        className={[
          "msg-text text-sm whitespace-pre-wrap px-3.5 py-2.5",
          role === "user"
            ? "bg-accent-blue text-white"
            : "bg-bg-input text-text-primary border border-border-subtle",
        ].join(" ")}
      >
        {message.text}
      </div>
    </div>
  );
}
