import { NextResponse } from "next/server";
import { deleteCourseMaterial, getCourseMaterial } from "@/db/course-store";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const material = await getCourseMaterial(id);
  if (!material) return NextResponse.json({ error: "资料不存在。" }, { status: 404 });
  return NextResponse.json({ material });
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const material = await deleteCourseMaterial(id);
  if (!material) return NextResponse.json({ error: "资料不存在。" }, { status: 404 });
  return NextResponse.json({ deleted: true, materialId: id, graphRevalidationRequired: true });
}
