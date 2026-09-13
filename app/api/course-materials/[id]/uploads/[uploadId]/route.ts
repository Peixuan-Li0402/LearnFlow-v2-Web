import { NextResponse } from "next/server";
import { bindings } from "@/db/store";
import { getCourseMaterial, saveCourseMaterial } from "@/db/course-store";

type RouteContext = { params: Promise<{ id: string; uploadId: string }> };

export async function DELETE(_request: Request, context: RouteContext) {
  const { id, uploadId } = await context.params;
  const material = await getCourseMaterial(id);
  if (!material) return NextResponse.json({ error: "资料不存在。" }, { status: 404 });
  const multipart = bindings().UPLOADS.resumeMultipartUpload(material.objectKey, uploadId);
  await multipart.abort().catch(() => undefined);
  await saveCourseMaterial({
    ...material,
    status: "ERROR",
    parseProgress: 0,
    error: "上传中断，可删除后重新上传。",
    updatedAt: new Date().toISOString(),
  });
  return NextResponse.json({ aborted: true });
}
