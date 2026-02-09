---

## `ARCHITECTURE.md`

```md
# Architecture

## Components

### 1) Worker (HTTP + orchestration)
- Routes requests:
  - `/api/chat` (sync)
  - `/api/chat/stream` (SSE)
  - `/api/clear`
  - `/api/task` (start workflow)
  - `/api/task?instanceId=...` (poll workflow)
- Calls Workers AI for inference
- Talks to Durable Object for memory
- Starts/polls Workflows for durable multi-step jobs

### 2) Durable Object: MemoryDO (state)
- Keyed by `user` query param (demo identity)
- Stores last N messages in DO storage
- Endpoints:
  - `GET /get` -> history
  - `POST /append` -> add message
  - `POST /clear` -> delete history
- Worker uses a DO stub via:
  - `env.MEMORY.idFromName(userId)`
  - `env.MEMORY.get(id)`
  - `stub.fetch("https://memory/...")`

### 3) Workers AI (inference)
- Model: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- Sync: `env.AI.run(model, { messages, max_tokens, temperature })`
- Stream: `env.AI.run(model, { ..., stream: true })` returning SSE bytes

### 4) Workflows (durable execution)
- `TaskWorkflow` runs multi-step jobs with `step.do("name", async () => ...)`
- Returns a serializable output:
  - `{ plan: string[], result: string }`
- Worker starts instances with:
  - `env.TASK_WORKFLOW.create({ id, params })`
- Worker polls instances with:
  - `env.TASK_WORKFLOW.get(id).status()`

## Data flow

### Chat
1. Client -> Worker `/api/chat`
2. Worker -> DO: append user message
3. Worker -> DO: fetch history
4. Worker -> Workers AI: run with `[system, ...history]`
5. Worker -> DO: append assistant message
6. Worker -> Client: `{ reply }`

### Streamed chat
1. Client -> Worker `/api/chat/stream`
2. Worker -> DO append + read history
3. Worker -> Workers AI `stream: true`
4. Worker forwards SSE bytes to client while accumulating final text to store in DO
5. Worker -> DO append assistant reply (best-effort)

### Workflow
1. Client -> Worker `/api/task`
2. Worker -> `TASK_WORKFLOW.create(...)` returns `{ id }`
3. Client auto-polls `/api/task?instanceId=...`
4. When complete, UI renders structured output (plan + result)

## Future improvements (nice for a portfolio)
- Auth (cookie/session/JWT) instead of `?user=...`
- Tool calling (search, DB, external APIs) inside a workflow step
- Rate limiting per user + cost controls
- Store workflow results into DO and reference them in chat