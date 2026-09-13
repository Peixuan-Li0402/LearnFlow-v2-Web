import { NextResponse } from "next/server";
import { deleteCourse, getCourseWorkspace, updateCourse } from "@/db/course-store";
import type { CourseSpace } from "@/lib/course-types";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const workspace = await getCourseWorkspace(id);
  if (!workspace) return NextResponse.json({ error: "课程空间不存在。" }, { status: 404 });
  return NextResponse.json(workspace);
}

export async function PUT(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const patch = (await request.json()) as Partial<CourseSpace>;
  const course = await updateCourse(id, patch);
  if (!course) return NextResponse.json({ error: "课程空间不存在。" }, { status: 404 });
  return NextResponse.json({ course });
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  await deleteCourse(id);
  return new Response(null, { status: 204 });
}

