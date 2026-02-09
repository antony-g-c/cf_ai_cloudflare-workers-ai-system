import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

export type TaskParams = { goal: string };
export type TaskOutput = { plan: string[]; result: string };

export type WorkflowEnv = { AI: any };

function safeJsonParse(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class TaskWorkflow extends WorkflowEntrypoint<WorkflowEnv, TaskParams> {
  async run(event: WorkflowEvent<TaskParams>, step: WorkflowStep): Promise<TaskOutput> {
    const goal = event.payload.goal;

    const plan = await step.do("plan", async () => {
      const r = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: [
          {
            role: "system",
            content:
              'You must respond with ONLY valid JSON of the form {"plan":["step 1","step 2","step 3"]}. No extra keys. No prose.',
          },
          { role: "user", content: goal },
        ],
        max_tokens: 180,
        temperature: 0.1,
      });

      const text = String(r?.response ?? r?.output_text ?? "");
      const obj = safeJsonParse(text);

      const steps =
        obj && Array.isArray(obj.plan) ? obj.plan.map((s: any) => String(s)).slice(0, 3) : null;

      // fallback if model returns junk
      return steps ?? ["Clarify goal", "Do the main work", "Summarize output"];
    });

    const result = await step.do("execute", async () => {
      const r = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: [
          {
            role: "system",
            content:
              "Return a concise final answer (max ~8 sentences). Do not repeat the plan. No 'final answer is' phrasing.",
          },
          { role: "user", content: `Goal: ${goal}\nPlan: ${JSON.stringify(plan)}` },
        ],
        max_tokens: 450,
        temperature: 0.2,
      });

      return String(r?.response ?? r?.output_text ?? "");
    });

    return { plan, result };
  }
}