import { NextResponse } from "next/server";
import { getKnowledgeNode } from "@/db/course-store";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const node = await getKnowledgeNode(id);
  if (!node) return NextResponse.json({ error: "知识点不存在。" }, { status: 404 });
  return NextResponse.json({ sourceRefs: node.sourceRefs });
}

