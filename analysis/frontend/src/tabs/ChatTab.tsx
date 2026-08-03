import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearChats,
  deleteChat,
  listChats,
  listOntologies,
  loadChat,
  saveChat,
  sendChat,
  streamChat,
  type ChatSummary,
  type Project,
  type ProjectOntology,
} from "../api";
import type { ChatMessage, ChatTrace, Meta } from "../types";
import ChatPipeline from "../components/ChatPipeline";
import SidePanel from "../components/SidePanel";
import ThinkingTicker from "../components/ThinkingTicker";
import { requestGraphFocus } from "../bus";
import { renderDiagram } from "../diagram";

/** Suggestions construites à partir de la référence du projet courant. */
function suggestionsFor(meta: Meta): string[] {
  const group = meta.lobes[0];
  const groupWord = meta.groupLabel.replace(/s$/, "").toLowerCase();
  const big = [...meta.modules].filter((m) => !m.external)[0];
  return [
    group
      ? `What is the ${group.label} ${groupWord}?`
      : `What is ${meta.ontology.title} about?`,
    group
      ? `How many direct subclasses does ${group.id} have?`
      : "Which classes have the most subclasses?",
    group
      ? `What is the longest subclass chain under the ${group.label} ${groupWord}?`
      : "What is the longest subclass chain in this ontology?",
    big
      ? `What does the ${big.id} module model?`
      : "Which concepts are the most connected?",
  ];
}

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

/* Mode expert : coché = pipeline GraphRAG complet, décoché = la réponse seule.
   La trace est streamée et stockée dans tous les cas, donc cocher la case
   ré-affiche a posteriori le raisonnement des réponses déjà reçues. */
const EXPERT_KEY = "dr.chat.expertMode";

function loadExpert(): boolean {
  try {
    return localStorage.getItem(EXPERT_KEY) === "1";
  } catch {
    return false;
  }
}

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
const savedMessages = new Map<string, ChatMessage[]>();
const savedChatId = new Map<string, string | null>();
const savedCtx = new Map<string, Set<string>>();

interface Props {
  /** Projet courant : ses conversations, sa référence, ses ontologies. */
  project: Project;
  meta: Meta;
}

export default function ChatTab({ project, meta }: Props) {
  const projectId = project.id;
  const [messages, setMessages] = useState<ChatMessage[]>(
    () => savedMessages.get(projectId) ?? []
  );
  const [chatId, setChatId] = useState<string | null>(
    () => savedChatId.get(projectId) ?? null
  );
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [input, setInput] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [expert, setExpert] = useState(loadExpert);
  /* Instant de la question : le chrono d'attente survit à la bascule du
     mode expert (qui démonte/remonte l'indicateur). */
  const [startedAt, setStartedAt] = useState(0);
  const [liveTrace, setLiveTrace] = useState<ChatTrace | null>(null);
  const [liveStage, setLiveStage] = useState<string | null>(null);
  const traceRef = useRef<ChatTrace>(emptyTrace());
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [wsOntos, setWsOntos] = useState<ProjectOntology[]>([]);
  const [ctxSel, setCtxSel] = useState<Set<string>>(
    () => savedCtx.get(projectId) ?? new Set()
  );
  const prefixes = meta.prefixes;
  const suggestions = useMemo(() => suggestionsFor(meta), [meta]);

  useEffect(() => {
    savedCtx.set(projectId, ctxSel);
  }, [projectId, ctxSel]);

  useEffect(() => {
    try {
      localStorage.setItem(EXPERT_KEY, expert ? "1" : "0");
    } catch {
      /* stockage indisponible : le mode reste valable pour la session */
    }
  }, [expert]);

  useEffect(() => {
    listOntologies(projectId)
      .then((list) => {
        const mapped = list.filter((o) => o.hasMapping && !o.inReference);
        setWsOntos(mapped);
        // purge des ontologies supprimées entre-temps
        setCtxSel((prev) => {
          const ids = new Set(mapped.map((o) => o.id));
          const next = new Set([...prev].filter((id) => ids.has(id)));
          return next.size === prev.size ? prev : next;
        });
      })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    savedMessages.set(projectId, messages);
  }, [projectId, messages]);
  useEffect(() => {
    savedChatId.set(projectId, chatId);
  }, [projectId, chatId]);

  const refreshList = useCallback(() => {
    listChats(projectId)
      .then(setChats)
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  const resolveIri = useCallback(
    (prefixed: string): string | null => {
      const m = prefixed.match(/^([A-Za-z][\w.-]*):([\w][\w.-]*)$/);
      if (!m) return null;
      const ns = prefixes[m[1]];
      return ns ? ns + m[2] : null;
    },
    [prefixes]
  );

  /** Mode simple : rend cliquables les IRIs/arêtes intégrés à la réponse. */
  const onAnswerClick = useCallback(
    (e: React.MouseEvent) => {
      const el = (e.target as Element).closest(
        "[data-iri],[data-curie],[data-efrom]"
      ) as HTMLElement | null;
      if (!el) return;
      const d = el.dataset;
      if (d.iri) {
        requestGraphFocus({ iri: d.iri });
      } else if (d.curie) {
        const iri = resolveIri(d.curie);
        if (iri) requestGraphFocus({ iri });
      } else if (d.efrom && d.eto) {
        const from = resolveIri(d.efrom);
        const to = resolveIri(d.eto);
        if (from && to) requestGraphFocus({ from, to, via: d.evia || undefined });
      }
    },
    [resolveIri]
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
      loadChat(projectId, id)
        .then((c) => {
          setChatId(c.id);
          setMessages(c.messages);
        })
        .catch(() => {});
    },
    [projectId, waiting, chatId]
  );

  const removeChat = useCallback(
    (id: string) => {
      deleteChat(projectId, id)
        .then(() => {
          refreshList();
          if (id === chatId) {
            setChatId(null);
            setMessages([]);
          }
        })
        .catch(() => {});
    },
    [projectId, chatId, refreshList]
  );

  const clearAll = useCallback(() => {
    if (!window.confirm("Delete ALL saved conversations? This cannot be undone.")) return;
    clearChats(projectId)
      .then(() => {
        setChats([]);
        setChatId(null);
        setMessages([]);
      })
      .catch(() => {});
  }, [projectId]);

  const persist = useCallback(
    (id: string, msgs: ChatMessage[]) => {
      saveChat(projectId, id, msgs)
        .then(() => refreshList())
        .catch(() => {});
    },
    [projectId, refreshList]
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
      setStartedAt(Date.now());
      setWaiting(true);
      persist(id, next); // le message utilisateur est déjà sauvegardé
      traceRef.current = emptyTrace();
      setLiveTrace(traceRef.current);
      setLiveStage("embed");
      try {
        const context =
          ctxSel.size > 0 ? { ontologies: [...ctxSel] } : undefined;
        let r;
        try {
          r = await streamChat(projectId, next, onEvent, context);
        } catch (streamErr) {
          // Backend plus ancien sans /api/chat/stream : bascule non-streamée
          console.warn("stream failed, falling back to plain chat", streamErr);
          r = await sendChat(projectId, next, context);
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
    [projectId, messages, waiting, onEvent, chatId, persist, ctxSel]
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
      <SidePanel
        id="chat-history"
        side="left"
        title="Chats"
        defaultWidth={240}
        min={180}
        max={420}
        className="chat-side"
      >
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
      </SidePanel>

      {/* ---- Conversation ---- */}
      <div className="chat-layout">
        <div className="chat-banner">
          <span>🔎</span>
          <span className="chat-banner-text">
            {expert ? (
              <>
                Answers are <strong>grounded in the ontology</strong> — watch the
                pipeline run live (vectorization, vector search, SPARQL / graph
                tools), then click any step under an answer to inspect it.
              </>
            ) : (
              <>
                Answers are <strong>grounded in the ontology</strong> — turn on{" "}
                <strong>Expert mode</strong> to unfold how each one was found.
              </>
            )}
          </span>
          <label
            className={`expert-toggle${expert ? " on" : ""}`}
            title={
              expert
                ? "Showing the full GraphRAG pipeline under every answer"
                : "Show the full GraphRAG pipeline (vectorization, retrieval, SPARQL, graph tools)"
            }
          >
            <input
              type="checkbox"
              checked={expert}
              onChange={(e) => setExpert(e.target.checked)}
            />
            <span>Expert mode</span>
          </label>
        </div>

        <div className="chat-scroll" ref={scrollRef}>
          <div className="chat-thread">
            {messages.length === 0 && !waiting ? (
              <div className="chat-empty">
                <div style={{ fontSize: 40 }}>💬</div>
                <div>
                  Ask a question about <strong>{meta.ontology.title}</strong> —
                  the reference ontology of the project {project.name}.
                </div>
                <div className="chat-suggestions">
                  {suggestions.map((s) => (
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
                      className={`chat-msg assistant${
                        expert && m.trace ? " with-pipe" : ""
                      }`}
                    >
                      {expert && m.trace ? (
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
                          {m.sparqlFailed && (
                            <div className="sparql-failed-note">
                              ⚠️ The structural query could not be executed — this
                              answer relies on retrieved concept descriptions only.
                            </div>
                          )}
                          <div
                            onClick={onAnswerClick}
                            dangerouslySetInnerHTML={{
                              __html: linkifyIris(renderMarkdown(m.content), resolveIri),
                            }}
                          />
                          {m.citations && m.citations.length > 0 && (
                            <div className="chat-citations">
                              {m.citations.map((c) => (
                                <span
                                  key={c.iri}
                                  className="chat-chip clickable"
                                  title={`${c.iri} — click to show in the graph`}
                                  onClick={() => requestGraphFocus({ iri: c.iri })}
                                >
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
                {waiting &&
                  (expert ? (
                    liveTrace && (
                      <div className="chat-msg assistant pipeline-live">
                        <ChatPipeline
                          trace={liveTrace}
                          activeStage={liveStage}
                          live
                          question={
                            [...messages].reverse().find((x) => x.role === "user")
                              ?.content
                          }
                        />
                      </div>
                    )
                  ) : (
                    <div className="chat-msg assistant thinking-msg">
                      <ThinkingTicker startedAt={startedAt} />
                    </div>
                  ))}
              </>
            )}
          </div>
        </div>

        {wsOntos.length > 0 && (
          <div className="ctx-bar" title="Ontologies included in the answer context">
            <span className="ctx-label">
              Context{ctxSel.size > 0 && ` (+${ctxSel.size})`}
            </span>
            <div className="ctx-chips">
            <span className="ctx-chip fixed" title="The project reference is always in the context">
              ★ {meta.ontology.title}
            </span>
            {wsOntos.map((o) => {
              const short = o.name.replace(/\.[^.]+$/, "");
              const on = ctxSel.has(o.id);
              return (
                <button
                  key={o.id}
                  className={`ctx-chip${on ? " on" : ""}`}
                  title={
                    on
                      ? "Remove this linked ontology from the chat context"
                      : "Answers will also use this linked ontology (with its reference links)"
                  }
                  onClick={() =>
                    setCtxSel((prev) => {
                      const next = new Set(prev);
                      if (next.has(o.id)) next.delete(o.id);
                      else next.add(o.id);
                      return next;
                    })
                  }
                >
                  {on ? "✓ " : "+ "}
                  {short}
                </button>
              );
            })}
            </div>
          </div>
        )}

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
