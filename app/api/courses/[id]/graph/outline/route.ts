import { NextResponse } from "next/server";
import { getCourse, updateCourse } from "@/db/course-store";
import type { CourseOutline } from "@/lib/course-types";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const course = await getCourse(id);
  if (!course) return NextResponse.json({ error: "课程空间不存在。" }, { status: 404 });
  return NextResponse.json({ outline: course.outline, confirmed: course.outlineConfirmed });
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const course = await getCourse(id);
  if (!course) return NextResponse.json({ error: "课程空间不存在。" }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { outline?: CourseOutline };
  const outline = body.outline || course.outline;
  if (!outline?.sections?.length) return NextResponse.json({ error: "课程目录为空，无法确认。" }, { status: 400 });
  const updated = await updateCourse(id, { outline, outlineConfirmed: true, status: "OUTLINE_CONFIRMED" });
  return NextResponse.json({ course: updated, outline, confirmed: true });
}

