import { NextResponse } from "next/server";
import { getKnowledgeNode, listRelatedProblems } from "@/db/course-store";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!(await getKnowledgeNode(id))) return NextResponse.json({ error: "知识点不存在。" }, { status: 404 });
  return NextResponse.json({ problems: await listRelatedProblems(id) });
}

