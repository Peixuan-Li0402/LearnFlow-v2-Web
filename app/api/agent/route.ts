import { NextResponse } from "next/server";
import type { AgentRequest } from "@/lib/agent-types";
import { buildCourseAgentContext } from "@/lib/course-agent-context";
import { callModel } from "@/lib/model-provider";
import { loadVisualReferences } from "@/lib/visual-reference-context";
import { agentErrorMessage } from "@/lib/agent-error";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as AgentRequest;
    if (!body || !["start_problem", "chat", "side_chat", "analyze_rollback", "parse_assignment"].includes(body.action)) {
      return NextResponse.json({ error: "不支持的操作。" }, { status: 400 });
    }
    if (body.action !== "parse_assignment" && !body.problem?.rawText?.trim()) {
      return NextResponse.json({ error: "请先选择一道完整的题目。" }, { status: 400 });
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(150_000)]);
    const courseContext = await buildCourseAgentContext(body);
    const visualReferences = await loadVisualReferences(body, courseContext);
    return NextResponse.json(await callModel({ ...body, courseContext, visualReferences }, signal));
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return NextResponse.json(
      { error: agentErrorMessage(error) },
      { status: 503 },
    );
  }
}
