# cloudfare-llm (Cloudflare Workers AI Chat + Memory + Streaming + Workflows)

A production-style AI app on Cloudflare:
- **LLM**: Workers AI (Llama 3.3)
- **User input**: Web UI (Vite + React) + HTTP API
- **Memory / state**: Durable Objects (per-user chat history)
- **Workflow / coordination**: Cloudflare Workflows (durable multi-step jobs)
- **Streaming**: Server-Sent Events (SSE) for token streaming

Live demo: `https://cloudfare-llm.antonygc.workers.dev`

---


## Architecture

```txt
Browser (Vite + React UI)
  |
  |  POST /api/chat?user=...
  |  POST /api/chat/stream?user=...
  |  POST /api/clear?user=...
  |  POST /api/task
  |  GET  /api/task?instanceId=...
  v
Cloudflare Worker (worker/index.ts)
  | \
  |  \-> Workers AI (Llama 3.3)
  |
  \-> Durable Object: MemoryDO (chat history per user)
  |
  \-> Workflow: TaskWorkflow (durable multi-step jobs)
