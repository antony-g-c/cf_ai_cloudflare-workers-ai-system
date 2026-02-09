export class MemoryDO {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/get") {
      const history = (await this.state.storage.get<any[]>("history")) ?? [];
      return Response.json({ history });
    }

    if (request.method === "POST" && url.pathname === "/append") {
      const msg = await request.json<{ role: string; content: string }>();
      const history = (await this.state.storage.get<any[]>("history")) ?? [];
      history.push(msg);

      // keep last 20 messages
      const trimmed = history.slice(-20);
      await this.state.storage.put("history", trimmed);
      return Response.json({ ok: true, size: trimmed.length });
    }

    if (request.method === "POST" && url.pathname === "/clear") {
      await this.state.storage.delete("history");
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }
}