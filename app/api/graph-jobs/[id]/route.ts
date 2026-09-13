import { NextResponse } from "next/server";
import { getGraphJob } from "@/db/course-store";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const job = await getGraphJob(id);
  if (!job) return NextResponse.json({ error: "图谱任务不存在。" }, { status: 404 });
  return NextResponse.json({ job });
}

