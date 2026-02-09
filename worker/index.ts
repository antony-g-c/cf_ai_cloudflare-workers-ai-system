import { MemoryDO } from "./memory_do";

export interface Env {
  AI: any; // Workers AI binding from wrangler.jsonc: "ai": { "binding": "AI" }
  MEMORY: DurableObjectNamespace; // DO binding from wrangler.jsonc: durable_objects.bindings[].name = "MEMORY"
  TASK_WORKFLOW: any; // Workflow binding
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Keep the starter behavior: only handle /api/*
    if (!url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 404 });
    }

    // Choose which Durable Object instance to use (memory per user)
    const userId = url.searchParams.get("user") ?? "demo";
    const doId = env.MEMORY.idFromName(userId);
    const stub = env.MEMORY.get(doId);

    // POST /api/chat  -> store user msg -> load history -> call LLM -> store reply -> return reply
    if (request.method === "POST" && url.pathname === "/api/chat") {
      const { message } = await request.json<{ message: string }>();

      await stub.fetch("https://memory/append", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "user", content: message }),
      });

      const memRes = await stub.fetch("https://memory/get", { method: "GET" });
      const { history } = await memRes.json<{ history: any[] }>();

      const system = {
        role: "system",
        content:
          "You are a helpful assistant. Use chat history for context. Be concise unless asked otherwise.",
      };

      const result = await env.AI.run(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        {
          messages: [system, ...history],
          max_tokens: 300,
          temperature: 0.4,
        }
      );

      const reply =
        result?.response ?? result?.output_text ?? JSON.stringify(result);

      await stub.fetch("https://memory/append", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "assistant", content: reply }),
      });

      return Response.json({ reply });
    }

    // POST /api/task -> start a workflow instance
    if (request.method === "POST" && url.pathname === "/api/task") {
      const { goal } = await request.json<{ goal: string }>();
      const newId = crypto.randomUUID();
      const instance = await env.TASK_WORKFLOW.create({
        id: newId,
        params: { goal },
      });
      return Response.json({ id: instance.id, status: await instance.status() });
    }

    // GET /api/task?instanceId=... -> check status/output
    if (request.method === "GET" && url.pathname === "/api/task") {
      const instanceId = url.searchParams.get("instanceId");
      if (!instanceId) return new Response("Missing instanceId", { status: 400 });

      const instance = await env.TASK_WORKFLOW.get(instanceId);
      return Response.json({ status: await instance.status() });
    }

    // POST /api/clear -> clears memory
    if (request.method === "POST" && url.pathname === "/api/clear") {
      await stub.fetch("https://memory/clear", { method: "POST" });
      return Response.json({ ok: true });
    }

    // ✅ POST /api/chat/stream  -> SSE streaming tokens + store final reply in memory
    if (request.method === "POST" && url.pathname === "/api/chat/stream") {
      const { message } = await request.json<{ message: string }>();

      // Save user message first
      await stub.fetch("https://memory/append", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "user", content: message }),
      });

      // Load history for context
      const memRes = await stub.fetch("https://memory/get", { method: "GET" });
      const { history } = await memRes.json<{ history: any[] }>();

      const system = {
        role: "system",
        content:
          "You are a helpful assistant. Use chat history for context. Be concise unless asked otherwise.",
      };

      // Ask Workers AI for a streaming SSE response
      const aiStream = (await env.AI.run(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        {
          messages: [system, ...history],
          stream: true,
          max_tokens: 400,
          temperature: 0.4,
        }
      )) as ReadableStream;

      // We want to BOTH: (a) forward SSE to client, (b) capture final text to store in memory.
      const decoder = new TextDecoder();

      let full = "";
      let buffer = "";

      const out = new ReadableStream({
        async start(controller) {
          const reader = aiStream.getReader();
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;

              // Forward bytes to client unchanged
              controller.enqueue(value);

              // Also try to parse SSE chunks to reconstruct final text for memory
              const chunkText = decoder.decode(value, { stream: true });
              buffer += chunkText;

              // SSE frames often separated by \n\n
              let idx;
              while ((idx = buffer.indexOf("\n\n")) !== -1) {
                const frame = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);

                // Parse lines like: data: {...}
                for (const line of frame.split("\n")) {
                  const trimmed = line.trim();
                  if (!trimmed.startsWith("data:")) continue;
                  const payload = trimmed.slice(5).trim();
                  if (!payload || payload === "[DONE]") continue;

                  try {
                    const obj = JSON.parse(payload);
                    // Workers AI SSE commonly includes "response" chunks
                    if (typeof obj.response === "string") full += obj.response;
                  } catch {
                    // ignore non-JSON data lines
                  }
                }
              }
            }
          } finally {
            // Store assistant reply (best-effort)
            if (full.trim().length > 0) {
              await stub.fetch("https://memory/append", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ role: "assistant", content: full }),
              });
            }
            controller.close();
          }
        },
      });

      return new Response(out, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
        },
      });
    }

    // keep starter default for other /api/* paths
    return Response.json({ name: "Cloudflare" });
  },
} satisfies ExportedHandler<Env>;

// This export is required so Wrangler can register the DO class
export { MemoryDO };
export { TaskWorkflow } from "./task_workflow";