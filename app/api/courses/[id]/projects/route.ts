import { NextResponse } from "next/server";
import {
  getCourse,
  listCourseAssignments,
} from "@/db/course-store";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!(await getCourse(id))) return NextResponse.json({ error: "课程不存在。" }, { status: 404 });
  return NextResponse.json({ projects: await listCourseAssignments(id) });
}

export async function POST() {
  return NextResponse.json(
    { error: "独立作业不能加入课程项目；请从课程空间新建项目内作业。" },
    { status: 405 },
  );
}
