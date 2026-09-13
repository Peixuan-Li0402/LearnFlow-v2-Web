import { NextResponse } from "next/server";
import { createCourse, listCourses } from "@/db/course-store";
import { courseUid, type CourseSpace } from "@/lib/course-types";

export async function GET() {
  return NextResponse.json({ courses: await listCourses() });
}

export async function POST(request: Request) {
  const body = (await request.json()) as { name?: string; description?: string };
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "课程名称不能为空。" }, { status: 400 });
  const timestamp = new Date().toISOString();
  const course: CourseSpace = {
    id: courseUid("course"),
    name,
    description: body.description?.trim() || "",
    status: "CREATED",
    outline: null,
    outlineConfirmed: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return NextResponse.json({ course: await createCourse(course) }, { status: 201 });
}

