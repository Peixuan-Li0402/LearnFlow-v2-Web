import { NextResponse } from "next/server";
import { bindings } from "@/db/store";
import { getCourseMaterial, saveCourseMaterial } from "@/db/course-store";

type RouteContext = { params: Promise<{ id: string; uploadId: string }> };
type UploadedPart = { partNumber: number; etag: string };

export async function POST(request: Request, context: RouteContext) {
  const { id, uploadId } = await context.params;
  const material = await getCourseMaterial(id);
  if (!material) return NextResponse.json({ error: "资料不存在。" }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { parts?: UploadedPart[] };
  const parts = (body.parts || [])
    .filter((part) => Number.isInteger(part.partNumber) && part.partNumber > 0 && typeof part.etag === "string" && part.etag)
    .sort((a, b) => a.partNumber - b.partNumber);
  if (!parts.length) return NextResponse.json({ error: "没有可合并的上传分片。" }, { status: 400 });

  const multipart = bindings().UPLOADS.resumeMultipartUpload(material.objectKey, uploadId);
  await multipart.complete(parts);
  const saved = await saveCourseMaterial({
    ...material,
    status: "UPLOADED",
    parseProgress: 5,
    error: undefined,
    updatedAt: new Date().toISOString(),
  });
  return NextResponse.json({ material: saved });
}
