import { NextResponse } from "next/server";
import { createGraphJob, getCourse } from "@/db/course-store";
import { courseUid, type GraphBuildJob } from "@/lib/course-types";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { id: courseId } = await context.params;
  const course = await getCourse(courseId);
  if (!course) return NextResponse.json({ error: "课程空间不存在。" }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { action?: "outline" | "graph" };
  const action = body.action === "graph" ? "graph" : "outline";
  if (action === "graph" && (!course.outline || !course.outlineConfirmed)) {
    return NextResponse.json({ error: "请先生成并确认课程目录。" }, { status: 409 });
  }
  const timestamp = new Date().toISOString();
  const job: GraphBuildJob = {
    id: courseUid("graph_job"),
    courseId,
    status: "QUEUED",
    stage: action === "graph" ? "BUILD_GRAPH" : "BUILD_OUTLINE",
    progress: 0,
    trace: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return NextResponse.json({ job: await createGraphJob(job) }, { status: 201 });
}

