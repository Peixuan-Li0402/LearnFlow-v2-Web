import { NextResponse } from "next/server";
import type { ProjectState } from "@/lib/agent-types";
import { deleteProject, getProject, saveProject } from "@/db/store";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const project = await getProject(id);
  if (!project) return NextResponse.json({ error: "项目不存在。" }, { status: 404 });
  return NextResponse.json({ project });
}

export async function PUT(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const project = (await request.json()) as ProjectState;
  if (project.id !== id) return NextResponse.json({ error: "项目 ID 不一致。" }, { status: 400 });
  await saveProject(project);
  return NextResponse.json({ project });
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  await deleteProject(id);
  return new Response(null, { status: 204 });
}

