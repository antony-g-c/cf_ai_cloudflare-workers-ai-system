import { useEffect, useMemo, useRef, useState } from "react";

type Msg = { role: "user" | "assistant"; content: string };

type TaskStatus = {
  status: string; // queued | running | complete | failed | ...
  error: string | null;
  output: any;
};

type TaskItem = {
  id: string;
  goal: string;
  status: TaskStatus;
  createdAt: number;
};

function Pill({ text }: { text: string }) {
  const bg =
    text === "complete"
      ? "rgba(34,197,94,0.15)"
      : text === "running"
      ? "rgba(59,130,246,0.15)"
      : text === "queued"
      ? "rgba(234,179,8,0.15)"
      : text === "failed"
      ? "rgba(239,68,68,0.15)"
      : "rgba(255,255,255,0.08)";

  const border =
    text === "complete"
      ? "rgba(34,197,94,0.35)"
      : text === "running"
      ? "rgba(59,130,246,0.35)"
      : text === "queued"
      ? "rgba(234,179,8,0.35)"
      : text === "failed"
      ? "rgba(239,68,68,0.35)"
      : "rgba(255,255,255,0.12)";

  return (
    <span
      style={{
        padding: "4px 8px",
        borderRadius: 999,
        border: `1px solid ${border}`,
        background: bg,
        fontSize: 12,
        opacity: 0.95,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

export default function App() {
  // ---------- Shared ----------
  const baseUrl = useMemo(() => "", []); // same origin

  const [userId, setUserId] = useState("antony");
  const [error, setError] = useState<string | null>(null);

  // ---------- Chat ----------
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatMode, setChatMode] = useState<"send" | "stream" | null>(null);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function sendOnce(text: string) {
    const res = await fetch(`${baseUrl}/api/chat?user=${encodeURIComponent(userId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    const data = (await res.json()) as { reply: string };
    return data.reply;
  }

  async function send() {
    const text = input.trim();
    if (!text || chatLoading) return;

    setError(null);
    setInput("");
    setChatLoading(true);
    setChatMode("send");
    setMessages((m) => [...m, { role: "user", content: text }]);

    try {
      const reply = await sendOnce(text);
      setMessages((m) => [...m, { role: "assistant", content: reply }]);
    } catch (e: any) {
      setError(e?.message ?? "Chat error.");
    } finally {
      setChatLoading(false);
      setChatMode(null);
    }
  }

  async function sendStream() {
    const text = input.trim();
    if (!text || chatLoading) return;

    setError(null);
    setInput("");
    setChatLoading(true);
    setChatMode("stream");

    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);

    try {
      const res = await fetch(`${baseUrl}/api/chat/stream?user=${encodeURIComponent(userId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok || !res.body) throw new Error(`Streaming failed (${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      let full = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          for (const line of frame.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;

            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;

            try {
              const obj = JSON.parse(payload);
              if (typeof obj.response === "string") {
                full += obj.response;

                setMessages((prev) => {
                  const next = [...prev];
                  const last = next.length - 1;
                  if (last >= 0 && next[last]?.role === "assistant") {
                    next[last] = { role: "assistant", content: full };
                  }
                  return next;
                });
              }
            } catch {
              // ignore
            }
          }
        }
      }
    } catch (e: any) {
      setError(e?.message ?? "Streaming error.");
    } finally {
      setChatLoading(false);
      setChatMode(null);
    }
  }

  async function clearMemory() {
    setError(null);
    setChatLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/clear?user=${encodeURIComponent(userId)}`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`Clear failed (${res.status})`);
      setMessages([]);
    } catch (e: any) {
      setError(e?.message ?? "Clear error.");
    } finally {
      setChatLoading(false);
      setChatMode(null);
    }
  }

  function onChatKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  // ---------- Workflows ----------
  const [taskGoal, setTaskGoal] = useState("");
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);
  const [autoPoll, setAutoPoll] = useState(true);
  const [lastPolledAt, setLastPolledAt] = useState<number | null>(null);

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null;

  async function startTask() {
    const goal = taskGoal.trim();
    if (!goal || taskLoading) return;

    setError(null);
    setTaskLoading(true);

    try {
      const res = await fetch(`${baseUrl}/api/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal }),
      });
      if (!res.ok) throw new Error(`Task start failed (${res.status})`);

      const data = (await res.json()) as { id: string; status: TaskStatus };

      const item: TaskItem = {
        id: data.id,
        goal,
        status: data.status,
        createdAt: Date.now(),
      };

      setTasks((prev) => [item, ...prev]);
      setSelectedTaskId(data.id);
      setTaskGoal("");
    } catch (e: any) {
      setError(e?.message ?? "Task error.");
    } finally {
      setTaskLoading(false);
    }
  }

  async function pollTask(id: string) {
    const res = await fetch(`${baseUrl}/api/task?instanceId=${encodeURIComponent(id)}`, {
      method: "GET",
    });
    if (!res.ok) throw new Error(`Task poll failed (${res.status})`);

    const data = (await res.json()) as { status: TaskStatus };

    setLastPolledAt(Date.now());
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, status: data.status } : t))
    );
  }

  // Auto-poll the selected task if it’s not finished
  useEffect(() => {
    if (!selectedTask) return;
    const s = selectedTask.status?.status;
    if (s === "complete" || s === "failed") return;

    const timer = setInterval(() => {
      pollTask(selectedTask.id).catch(() => {});
    }, 2000);

    return () => clearInterval(timer);
  }, [selectedTask?.id, selectedTask?.status?.status]);

  // ---------- Layout ----------
  const chatStatus =
    chatLoading && chatMode === "stream"
      ? "Streaming…"
      : chatLoading && chatMode === "send"
      ? "Sending…"
      : "Ready";

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0b0f17",
        color: "#e6e6e6",
        fontFamily: "ui-sans-serif, system-ui, -apple-system",
      }}
    >
      {/* Top bar (full width) */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 20,
          backdropFilter: "blur(10px)",
          background: "rgba(11, 15, 23, 0.75)",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <div
          style={{
            padding: "14px 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ fontSize: 18, fontWeight: 750 }}>Cloudflare Llama Chat</div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              Durable Objects memory · Workers AI (Llama 3.3) · Streaming · Workflows
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="user id"
              style={{
                width: 240,
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.06)",
                color: "#e6e6e6",
                outline: "none",
              }}
            />
            <button
              onClick={clearMemory}
              disabled={chatLoading}
              style={{
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.06)",
                color: "#e6e6e6",
                cursor: chatLoading ? "not-allowed" : "pointer",
              }}
              title="Clears Durable Object history for this userId"
            >
              Clear Memory
            </button>
          </div>
        </div>

        {error && (
          <div
            style={{
              margin: "0 16px 12px",
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(255, 100, 100, 0.35)",
              background: "rgba(255, 80, 80, 0.10)",
              color: "#ffd1d1",
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}
      </div>

      {/* Full-width 2-pane workspace */}
      <div
        className="layout"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.65fr) minmax(360px, 1fr)",
          gap: 16,
          padding: "16px",
          height: "calc(100vh - 76px)", // subtract top bar
          boxSizing: "border-box",
        }}
      >
        {/* LEFT: Chat panel */}
        <div
          style={{
            border: "1px solid rgba(255,255,255,0.10)",
            borderRadius: 16,
            background: "rgba(255,255,255,0.03)",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
          }}
        >
          <div style={{ padding: 14, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div style={{ fontWeight: 700 }}>Chat</div>
              <Pill text={chatStatus} />
            </div>
            <div style={{ fontSize: 12, opacity: 0.65, marginTop: 6 }}>
              Send = /api/chat · Stream = /api/chat/stream
            </div>
          </div>

          {/* Scroll area */}
          <div style={{ padding: 14, overflowY: "auto", flex: 1 }}>
            {messages.length === 0 ? (
              <div
                style={{
                  border: "1px dashed rgba(255,255,255,0.18)",
                  borderRadius: 16,
                  padding: 18,
                  opacity: 0.85,
                }}
              >
                <div style={{ fontWeight: 650, marginBottom: 6 }}>Quick demo:</div>
                <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
                  <li>“Remember my major is CS at Georgia Tech.”</li>
                  <li>“What do you remember about me?”</li>
                  <li>Use <b>Stream</b> to show token streaming.</li>
                </ol>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {messages.map((m, i) => {
                  const isUser = m.role === "user";
                  return (
                    <div key={i} style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start" }}>
                      <div
                        style={{
                          maxWidth: "78%",
                          padding: "12px 14px",
                          borderRadius: 16,
                          border: "1px solid rgba(255,255,255,0.12)",
                          background: isUser ? "rgba(99, 102, 241, 0.20)" : "rgba(255,255,255,0.06)",
                          whiteSpace: "pre-wrap",
                          lineHeight: 1.45,
                        }}
                      >
                        <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 6 }}>
                          {isUser ? "You" : "Assistant"}
                        </div>
                        {m.content || (chatLoading && !isUser ? "…" : "")}
                      </div>
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>
            )}
          </div>

          {/* Input bar INSIDE the chat panel (no overlap possible) */}
          <div
            style={{
              borderTop: "1px solid rgba(255,255,255,0.08)",
              padding: 12,
              display: "flex",
              gap: 10,
              alignItems: "stretch",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onChatKeyDown}
                placeholder="Enter to send · Shift+Enter for newline"
                rows={2}
                style={{
                  width: "100%",
                  resize: "none",
                  padding: "12px 12px",
                  borderRadius: 14,
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(255,255,255,0.06)",
                  color: "#e6e6e6",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.6 }}>
                {chatStatus}
              </div>
            </div>

            <div style={{ width: 160, display: "flex", flexDirection: "column", gap: 8 }}>
              <button
                onClick={send}
                disabled={chatLoading}
                style={{
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(255,255,255,0.08)",
                  color: "#e6e6e6",
                  cursor: chatLoading ? "not-allowed" : "pointer",
                  fontWeight: 700,
                }}
              >
                {chatLoading && chatMode === "send" ? "Sending…" : "Send"}
              </button>
              <button
                onClick={sendStream}
                disabled={chatLoading}
                style={{
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(99, 102, 241, 0.25)",
                  color: "#e6e6e6",
                  cursor: chatLoading ? "not-allowed" : "pointer",
                  fontWeight: 700,
                }}
                title="Streams tokens via SSE"
              >
                {chatLoading && chatMode === "stream" ? "Streaming…" : "Stream"}
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT: Workflows workspace */}
        <div
          style={{
            border: "1px solid rgba(255,255,255,0.10)",
            borderRadius: 16,
            background: "rgba(255,255,255,0.03)",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
          }}
        >
          <div style={{ padding: 14, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div style={{ fontWeight: 700 }}>Workflows</div>
              <div style={{ fontSize: 12, opacity: 0.65 }}>POST /api/task · GET /api/task</div>
            </div>
          </div>

          {/* Create task */}
          <div style={{ padding: 14, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
              Run a durable multi-step task (great for “agent-like” behavior).
            </div>

            <textarea
              value={taskGoal}
              onChange={(e) => setTaskGoal(e.target.value)}
              placeholder='Example: "Summarize 3 differences between Durable Objects and KV and recommend when to use each."'
              rows={4}
              style={{
                width: "100%",
                resize: "vertical",
                padding: "12px 12px",
                borderRadius: 14,
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.06)",
                color: "#e6e6e6",
                outline: "none",
                boxSizing: "border-box",
              }}
            />

            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button
                onClick={startTask}
                disabled={taskLoading}
                style={{
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(255,255,255,0.08)",
                  color: "#e6e6e6",
                  cursor: taskLoading ? "not-allowed" : "pointer",
                  fontWeight: 700,
                  flex: 1,
                }}
              >
                {taskLoading ? "Starting…" : "Run Task"}
              </button>

            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginTop: 10 }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, opacity: 0.8 }}>
                <input
                  type="checkbox"
                  checked={autoPoll}
                  onChange={(e) => setAutoPoll(e.target.checked)}
                  style={{ transform: "translateY(1px)" }}
                />
                Auto-poll (every 2s)
              </label>

              <div style={{ fontSize: 12, opacity: 0.65 }}>
                {lastPolledAt ? `Last updated: ${new Date(lastPolledAt).toLocaleTimeString()}` : "—"}
              </div>
            </div>
          </div>

          {/* Tasks list + details */}
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", flex: 1, overflow: "hidden" }}>
            {/* list */}
            <div style={{ overflowY: "auto" }}>
              {tasks.length === 0 ? (
                <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ fontSize: 13, opacity: 0.85, fontWeight: 650 }}>
                    No tasks yet
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.7, lineHeight: 1.5 }}>
                    Workflows are for longer, multi-step work that should be durable (retries, steps, progress).
                    Pick a template below or write your own goal.
                  </div>

                  <div style={{ display: "grid", gap: 10 }}>
                    {[
                      "Compare Durable Objects vs KV vs D1 and recommend when to use each.",
                      "Draft a README for this project with a clean architecture diagram and demo script.",
                      "Given my chat history, propose 3 improvements to reduce cost and latency.",
                      "Create a 5-step plan to add tool-calling (web search) safely and rate-limited.",
                    ].map((t) => (
                      <button
                        key={t}
                        onClick={() => setTaskGoal(t)}
                        style={{
                          textAlign: "left",
                          padding: 12,
                          borderRadius: 14,
                          border: "1px solid rgba(255,255,255,0.10)",
                          background: "rgba(255,255,255,0.05)",
                          color: "#e6e6e6",
                          cursor: "pointer",
                          lineHeight: 1.35,
                        }}
                        title="Click to load into the goal box"
                      >
                        {t}
                      </button>
                    ))}
                  </div>

                  <div style={{ fontSize: 12, opacity: 0.6 }}>
                    Tip: click a template → hit <b>Run Task</b>.
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {tasks.map((t) => {
                    const active = t.id === selectedTaskId;
                    return (
                      <button
                        key={t.id}
                        onClick={() => setSelectedTaskId(t.id)}
                        style={{
                          textAlign: "left",
                          padding: 12,
                          border: "none",
                          borderTop: "1px solid rgba(255,255,255,0.06)",
                          background: active ? "rgba(255,255,255,0.06)" : "transparent",
                          color: "#e6e6e6",
                          cursor: "pointer",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                          <div style={{ fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {t.goal}
                          </div>
                          <Pill text={t.status?.status ?? "unknown"} />
                        </div>
                        <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>
                          {t.id.slice(0, 8)}… · {new Date(t.createdAt).toLocaleTimeString()}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* details */}
            <div
              style={{
                borderTop: "1px solid rgba(255,255,255,0.08)",
                padding: 14,
                background: "rgba(0,0,0,0.15)",
              }}
            >
              {!selectedTask ? (
                <div style={{ fontSize: 13, opacity: 0.75 }}>
                  Select a task to view details.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                    <div style={{ fontWeight: 750 }}>Task Details</div>
                    <Pill text={selectedTask.status.status} />
                  </div>

                  <div style={{ fontSize: 12, opacity: 0.75 }}>
                    <div><b>ID:</b> {selectedTask.id}</div>
                    <div><b>Goal:</b> {selectedTask.goal}</div>
                    {selectedTask.status.error ? <div><b>Error:</b> {selectedTask.status.error}</div> : null}
                  </div>

                  <div
                    style={{
                      padding: 12,
                      borderRadius: 14,
                      border: "1px solid rgba(255,255,255,0.10)",
                      background: "rgba(0,0,0,0.25)",
                      fontSize: 12,
                      whiteSpace: "pre-wrap",
                      lineHeight: 1.45,
                      maxHeight: 260,
                      overflowY: "auto",
                    }}
                  >
                    <b>Plan</b>
                    {"\n"}
                    {Array.isArray((selectedTask.status.output as any)?.plan) ? (
                      <ul style={{ margin: "8px 0 12px 18px" }}>
                        {(selectedTask.status.output as any).plan.map((s: string, i: number) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    ) : (
                      <div style={{ opacity: 0.75, marginTop: 6 }}>(No plan yet)</div>
                    )}

                    <b>Result</b>
                    {"\n\n"}
                    {typeof (selectedTask.status.output as any)?.result === "string"
                      ? (selectedTask.status.output as any).result
                      : "(No result yet — keep polling until complete.)"}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Responsive stacking */}
        <style>{`
          @media (max-width: 980px) {
            .layout {
              grid-template-columns: 1fr !important;
              height: auto !important;
            }
          }
        `}</style>
      </div>
    </div>
  );
}