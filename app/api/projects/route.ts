import { NextResponse } from "next/server";
import type { ProjectState } from "@/lib/agent-types";
import { listProjects, saveProject } from "@/db/store";
import { attachProjectToCourse } from "@/db/course-store";

export async function GET() {
  return NextResponse.json({ projects: await listProjects() });
}

export async function POST(request: Request) {
  const project = (await request.json()) as ProjectState;
  if (!project.id || !project.name) {
    return NextResponse.json({ error: "项目名称不能为空。" }, { status: 400 });
  }
  await saveProject(project);
  if (project.courseId) await attachProjectToCourse(project.id, project.courseId);
  return NextResponse.json({ project }, { status: 201 });
}
