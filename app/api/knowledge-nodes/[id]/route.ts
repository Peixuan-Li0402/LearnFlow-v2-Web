import { NextResponse } from "next/server";
import { getKnowledgeNode, updateNodeLearningStatus } from "@/db/course-store";
import type { LearningStatus } from "@/lib/course-types";

type RouteContext = { params: Promise<{ id: string }> };
const statuses = new Set<LearningStatus>(["UNSEEN", "LEARNING", "UNDERSTOOD", "REVIEW"]);

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const node = await getKnowledgeNode(id);
  if (!node) return NextResponse.json({ error: "知识点不存在。" }, { status: 404 });
  return NextResponse.json({ node });
}

export async function PUT(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const body = (await request.json()) as { learningStatus?: LearningStatus; evidence?: string[] };
  if (!body.learningStatus || !statuses.has(body.learningStatus)) {
    return NextResponse.json({ error: "学习状态无效。" }, { status: 400 });
  }
  const node = await updateNodeLearningStatus(id, body.learningStatus, body.evidence || ["用户主动标记"]);
  if (!node) return NextResponse.json({ error: "知识点不存在。" }, { status: 404 });
  return NextResponse.json({ node });
}

