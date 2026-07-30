import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearChats,
  deleteChat,
  fetchMeta,
  listChats,
  loadChat,
  saveChat,
  sendChat,
  streamChat,
  type ChatSummary,
} from "../api";
import type { ChatMessage, ChatTrace } from "../types";
import ChatPipeline from "../components/ChatPipeline";
import { requestGraphFocus } from "../bus";
import { renderDiagram } from "../diagram";

const SUGGESTIONS = [
  "What is the Supply Chain lobe?",
  "How many direct subclasses does the Supply_Chain_Lobe have?",
  "What is the longest subclass chain under the Supply Chain lobe?",
  "How does the ontology model CO2 emissions?",
];

/** Rendu markdown minimal : titres, listes (à puces et numérotées), blocs de
    code ```…```, diagrammes ```diagram, gras/italique/`code`. */
function renderMarkdown(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const lines = esc.split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let inCode = false;
  let diagLines: string[] | null = null;
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      closeList();
      const lang = line.trim().slice(3).trim().toLowerCase();
      if (diagLines) {
        out.push(renderDiagram(diagLines)); // fin du bloc diagramme
        diagLines = null;
      } else if (inCode) {
        out.push("</pre>");
        inCode = false;
      } else if (lang === "diagram") {
        diagLines = [];
      } else {
        out.push('<pre class="md-code">');
        inCode = true;
      }
      continue;
    }
    if (diagLines) {
      diagLines.push(line);
      continue;
    }
    if (inCode) {
      out.push(line + "\n");
      continue;
    }
    const inline = line
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
      .replace(/`(.+?)`/g, "<code>$1</code>");
    const h = line.match(/^(#{1,4})\s+/);
    if (h) {
      closeList();
      const lvl = Math.min(6, h[1].length + 2); // # → h3 … #### → h6
      out.push(`<h${lvl}>${inline.replace(/^#{1,4}\s+/, "")}</h${lvl}>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inline.replace(/^\s*[-*]\s+/, "")}</li>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inline.replace(/^\s*\d+[.)]\s+/, "")}</li>`);
      continue;
    }
    closeList();
    if (line.trim()) out.push(`<p>${inline}</p>`);
  }
  if (diagLines) out.push(renderDiagram(diagLines));
  if (inCode) out.push("</pre>");
  closeList();
  return out.join("");
}

const emptyTrace = (): ChatTrace => ({ sparqlAttempts: [] });

/** Rend cliquables les IRIs préfixés (`dr:X`) présents dans la réponse. */
function linkifyIris(
  html: string,
  resolve: (prefixed: string) => string | null
): string {
  return html.replace(
    /<code>([A-Za-z][\w.-]*:[\w][\w.-]*)<\/code>/g,
    (full, prefixed: string) => {
      const iri = resolve(prefixed);
      return iri
        ? `<code class="iri-link" data-iri="${iri}" title="Show in the graph">${prefixed}</code>`
        : full;
    }
  );
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

// La conversation courante survit au démontage de l'onglet (un seul onglet
// monté à la fois pour économiser la mémoire).
let savedMessages: ChatMessage[] = [];
let savedChatId: string | null = null;

export default function ChatTab() {
  const [messages, setMessages] = useState<ChatMessage[]>(savedMessages);
  const [chatId, setChatId] = useState<string | null>(savedChatId);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [input, setInput] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [liveTrace, setLiveTrace] = useState<ChatTrace | null>(null);
  const [liveStage, setLiveStage] = useState<string | null>(null);
  const traceRef = useRef<ChatTrace>(emptyTrace());
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [prefixes, setPrefixes] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    savedMessages = messages;
  }, [messages]);
  useEffect(() => {
    savedChatId = chatId;
  }, [chatId]);

  const refreshList = useCallback(() => {
    listChats()
      .then(setChats)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshList();
    fetchMeta()
      .then((m) => setPrefixes(m.prefixes))
      .catch(() => {});
  }, [refreshList]);

  const resolveIri = useCallback(
    (prefixed: string): string | null => {
      const m = prefixed.match(/^([A-Za-z][\w.-]*):([\w][\w.-]*)$/);
      if (!m || !prefixes) return null;
      const ns = prefixes[m[1]];
      return ns ? ns + m[2] : null;
    },
    [prefixes]
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, waiting, liveStage, liveTrace]);

  const onEvent = useCallback((ev: Record<string, unknown>) => {
    const t = traceRef.current;
    switch (ev.type) {
      case "stage":
        setLiveStage(ev.stage as string);
        break;
      case "rewrite":
        t.rewrite = { standalone: ev.standalone as string };
        break;
      case "embed":
        t.embed = ev as unknown as ChatTrace["embed"];
        break;
      case "retrieval":
        t.retrieval = ev as unknown as ChatTrace["retrieval"];
        break;
      case "route":
        t.route = ev.route as string;
        break;
      case "sparql_attempt":
        t.sparqlAttempts.push({
          attempt: ev.attempt as number,
          query: ev.query as string,
        });
        break;
      case "sparql_result": {
        const a = t.sparqlAttempts.find((x) => x.attempt === ev.attempt);
        if (a) {
          a.ok = ev.ok as boolean;
          a.rows = ev.rows as number | undefined;
          a.error = ev.error as string | undefined;
        }
        break;
      }
      case "graph_tool":
        t.graph = { tool: ev.tool as string };
        break;
      case "graph_result":
        if (t.graph) t.graph.detail = ev.detail as string;
        break;
    }
    setLiveTrace({ ...t });
  }, []);

  /* ---- Gestion des conversations ---- */

  const newChat = useCallback(() => {
    if (waiting) return;
    setChatId(null);
    setMessages([]);
    inputRef.current?.focus();
  }, [waiting]);

  const openChat = useCallback(
    (id: string) => {
      if (waiting || id === chatId) return;
      loadChat(id)
        .then((c) => {
          setChatId(c.id);
          setMessages(c.messages);
        })
        .catch(() => {});
    },
    [waiting, chatId]
  );

  const removeChat = useCallback(
    (id: string) => {
      deleteChat(id)
        .then(() => {
          refreshList();
          if (id === chatId) {
            setChatId(null);
            setMessages([]);
          }
        })
        .catch(() => {});
    },
    [chatId, refreshList]
  );

  const clearAll = useCallback(() => {
    if (!window.confirm("Delete ALL saved conversations? This cannot be undone.")) return;
    clearChats()
      .then(() => {
        setChats([]);
        setChatId(null);
        setMessages([]);
      })
      .catch(() => {});
  }, []);

  const persist = useCallback(
    (id: string, msgs: ChatMessage[]) => {
      saveChat(id, msgs)
        .then(() => refreshList())
        .catch(() => {});
    },
    [refreshList]
  );

  /* ---- Envoi ---- */

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || waiting) return;
      const id = chatId ?? crypto.randomUUID();
      if (!chatId) setChatId(id);
      const next: ChatMessage[] = [...messages, { role: "user", content }];
      setMessages(next);
      setInput("");
      setWaiting(true);
      persist(id, next); // le message utilisateur est déjà sauvegardé
      traceRef.current = emptyTrace();
      setLiveTrace(traceRef.current);
      setLiveStage("embed");
      try {
        let r;
        try {
          r = await streamChat(next, onEvent);
        } catch (streamErr) {
          // Backend plus ancien sans /api/chat/stream : bascule non-streamée
          console.warn("stream failed, falling back to plain chat", streamErr);
          r = await sendChat(next);
        }
        const done: ChatMessage[] = [
          ...next,
          {
            role: "assistant",
            content: r.reply,
            citations: r.citations,
            sparql: r.sparql,
            sparqlFailed: r.sparqlFailed,
            trace: { ...traceRef.current },
          },
        ];
        setMessages(done);
        persist(id, done);
      } catch (e) {
        const done: ChatMessage[] = [
          ...next,
          {
            role: "assistant",
            content: `**Error**: could not reach the backend (${
              e instanceof Error ? e.message : e
            }).`,
          },
        ];
        setMessages(done);
        persist(id, done);
      } finally {
        setWaiting(false);
        setLiveTrace(null);
        setLiveStage(null);
        inputRef.current?.focus();
      }
    },
    [messages, waiting, onEvent, chatId, persist]
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };

  return (
    <div className="chat-page">
      {/* ---- Historique des conversations ---- */}
      <aside className="chat-side">
        <button className="new-chat-btn" onClick={newChat} disabled={waiting}>
          ＋ New chat
        </button>
        <div className="conv-list">
          {chats.map((c) => (
            <div
              key={c.id}
              className={`conv-item${c.id === chatId ? " active" : ""}`}
              onClick={() => openChat(c.id)}
              title={c.title}
            >
              <div className="conv-title">{c.title}</div>
              <div className="conv-meta">
                {fmtDate(c.updatedAt)} · {c.messageCount} msg
              </div>
              <button
                className="conv-del"
                title="Delete this conversation"
                onClick={(e) => {
                  e.stopPropagation();
                  removeChat(c.id);
                }}
              >
                🗑
              </button>
            </div>
          ))}
          {chats.length === 0 && (
            <div className="conv-empty">No saved conversations yet</div>
          )}
        </div>
        {chats.length > 0 && (
          <button className="clear-all-btn" onClick={clearAll} disabled={waiting}>
            Clear all conversations
          </button>
        )}
      </aside>

      {/* ---- Conversation ---- */}
      <div className="chat-layout">
        <div className="chat-banner">
          <span>🔎</span>
          <span>
            Answers are <strong>grounded in the ontology</strong> — watch the
            pipeline run live (vectorization, vector search, SPARQL / graph
            tools), then click any step under an answer to inspect it.
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
                    className={`chat-msg assistant${m.trace ? " with-pipe" : ""}`}
                  >
                    {m.trace ? (
                      <ChatPipeline
                        trace={m.trace}
                        activeStage={null}
                        live={false}
                        citations={m.citations}
                        answerHtml={linkifyIris(renderMarkdown(m.content), resolveIri)}
                        sparqlFailed={m.sparqlFailed}
                        question={
                          messages[i - 1]?.role === "user"
                            ? messages[i - 1].content
                            : undefined
                        }
                        onPeek={requestGraphFocus}
                        resolveIri={resolveIri}
                      />
                    ) : (
                      <>
                        <div
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
                        />
                        {m.citations && m.citations.length > 0 && (
                          <div className="chat-citations">
                            {m.citations.map((c) => (
                              <span key={c.iri} className="chat-chip" title={c.iri}>
                                {c.label}
                                <span className="chip-module">{c.module}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )
              )}
              {waiting && liveTrace && (
                <div className="chat-msg assistant pipeline-live">
                  <ChatPipeline
                    trace={liveTrace}
                    activeStage={liveStage}
                    live
                    question={
                      [...messages].reverse().find((x) => x.role === "user")?.content
                    }
                  />
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
    </div>
  );
}
