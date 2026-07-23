import { useCallback, useEffect, useRef, useState } from "react";
import { sendChat } from "../api";
import type { ChatMessage } from "../types";

const SUGGESTIONS = [
  "What is the Supply Chain lobe?",
  "Which classes describe semiconductor production?",
  "Tell me about forecasting and planning",
  "What does the ontology contain about CO2?",
];

/** Rendu markdown minimal (gras, italique, listes) avec échappement HTML. */
function renderMarkdown(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const lines = esc.split("\n");
  const out: string[] = [];
  let inList = false;
  for (const line of lines) {
    const inline = line
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/_(.+?)_/g, "<em>$1</em>")
      .replace(/`(.+?)`/g, "<code>$1</code>");
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline.replace(/^\s*[-*]\s+/, "")}</li>`);
    } else {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      if (line.trim()) out.push(`<p>${inline}</p>`);
    }
  }
  if (inList) out.push("</ul>");
  return out.join("");
}

export default function ChatTab() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [waiting, setWaiting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, waiting]);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || waiting) return;
      const next: ChatMessage[] = [...messages, { role: "user", content }];
      setMessages(next);
      setInput("");
      setWaiting(true);
      try {
        const reply = await sendChat(next);
        setMessages([...next, { role: "assistant", content: reply }]);
      } catch (e) {
        setMessages([
          ...next,
          {
            role: "assistant",
            content: `**Error**: could not reach the backend (${
              e instanceof Error ? e.message : e
            }).`,
          },
        ]);
      } finally {
        setWaiting(false);
        inputRef.current?.focus();
      }
    },
    [messages, waiting]
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };

  return (
    <div className="chat-layout">
      <div className="chat-banner">
        <span>🧪</span>
        <span>
          <strong>Demo interface</strong> — the GraphRAG engine is not wired up
          yet. Current answers come from a simple lexical search over the
          ontology; the interface is ready for the integration.
        </span>
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && !waiting ? (
          <div className="chat-empty">
            <div style={{ fontSize: 40 }}>💬</div>
            <div>
              Ask a question about the <strong>Digital Reference</strong> to
              explore the ontology.
            </div>
            <div className="chat-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="chat-msg user">
                  {m.content}
                </div>
              ) : (
                <div
                  key={i}
                  className="chat-msg assistant"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
                />
              )
            )}
            {waiting && (
              <div className="chat-msg assistant">
                <span className="typing-dots">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="chat-input-row">
        <textarea
          ref={inputRef}
          className="chat-input"
          rows={1}
          placeholder="Your question… (Enter to send, Shift+Enter for a new line)"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            const el = e.target;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
          }}
          onKeyDown={onKeyDown}
        />
        <button
          className="chat-send"
          disabled={waiting || !input.trim()}
          onClick={() => void send(input)}
        >
          Send
        </button>
      </div>
    </div>
  );
}
