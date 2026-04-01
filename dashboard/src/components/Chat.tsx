import { useState, useCallback, useRef, useEffect } from "react";
import { usePolling } from "../hooks/usePolling";
import * as api from "../api";
import type { Message } from "../types";

interface Props {
  projectId: string;
}

export function Chat({ projectId }: Props) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const fetcher = useCallback(() => api.fetchMessages(projectId, 100), [projectId]);
  const { data: messages, refresh } = usePolling(fetcher, 3000);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages?.length]);

  const handleSend = async () => {
    if (!input.trim()) return;
    await api.sendMessage(projectId, input);
    setInput("");
    refresh();
  };

  return (
    <div className="chat">
      <div className="chat-messages">
        {messages?.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="chat-input">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          placeholder="Message Tech Lead..."
        />
        <button onClick={handleSend}>Send</button>
      </div>
    </div>
  );
}

function ChatMessage({ message }: { message: Message }) {
  const roleClass = message.fromRole === "user" ? "msg-user" :
    message.fromRole === "tech-lead" ? "msg-agent" : "msg-system";

  const label = message.fromRole === "user" ? "You" :
    message.fromRole === "tech-lead" ? "Tech Lead" : "System";

  return (
    <div className={`chat-msg ${roleClass}`}>
      <div className="msg-header">
        <span className="msg-author">{label}</span>
        <span className="msg-source">{message.source}</span>
        <span className="msg-time">{new Date(message.createdAt).toLocaleTimeString()}</span>
      </div>
      <div className="msg-text">{message.text}</div>
    </div>
  );
}
