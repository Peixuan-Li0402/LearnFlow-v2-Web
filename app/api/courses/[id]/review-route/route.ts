import { NextResponse } from "next/server";
import { getCourseGraph, getReviewRoute, saveReviewRoute } from "@/db/course-store";
import { generateReviewRoute } from "@/lib/course-model";
import type { ReviewRouteInput } from "@/lib/course-types";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  return NextResponse.json({ route: await getReviewRoute(id) });
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const input = (await request.json()) as ReviewRouteInput;
  if (!input.examDate || !input.scope?.trim() || !Number.isFinite(input.dailyMinutes) || input.dailyMinutes < 10) {
    return NextResponse.json({ error: "请填写考试日期、复习范围和每天可用时间。" }, { status: 400 });
  }
  const graph = await getCourseGraph(id);
  if (!graph) return NextResponse.json({ error: "请先生成课程知识图谱。" }, { status: 409 });
  const route = await generateReviewRoute(id, { ...input, reviewedNodeIds: input.reviewedNodeIds || [] }, graph);
  if (!route.items.length) return NextResponse.json({ error: "模型没有生成可执行的复习路线。" }, { status: 502 });
  return NextResponse.json({ route: await saveReviewRoute(route) });
}

