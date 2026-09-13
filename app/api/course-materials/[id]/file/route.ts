import { NextResponse } from "next/server";
import { bindings } from "@/db/store";
import { getCourseMaterial } from "@/db/course-store";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const material = await getCourseMaterial(id);
  if (!material) return NextResponse.json({ error: "资料不存在。" }, { status: 404 });
  const object = await bindings().UPLOADS.get(material.objectKey);
  if (!object?.body) return NextResponse.json({ error: "原始文件不存在。" }, { status: 404 });
  return new Response(object.body, {
    headers: {
      "Content-Type": material.mimeType,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(material.name)}`,
      "Cache-Control": "private, max-age=300",
    },
  });
}

