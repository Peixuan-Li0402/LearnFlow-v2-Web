import { NextResponse } from "next/server";
import { bindings } from "@/db/store";
import { getCourseMaterial } from "@/db/course-store";
import { COURSE_MATERIAL_PART_SIZE } from "@/lib/course-material-upload";

type RouteContext = { params: Promise<{ id: string; uploadId: string; partNumber: string }> };

export async function PUT(request: Request, context: RouteContext) {
  const { id, uploadId, partNumber: partText } = await context.params;
  const material = await getCourseMaterial(id);
  if (!material) return NextResponse.json({ error: "资料不存在。" }, { status: 404 });
  const partNumber = Number(partText);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return NextResponse.json({ error: "分片编号无效。" }, { status: 400 });
  }
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > COURSE_MATERIAL_PART_SIZE) {
    return NextResponse.json({ error: "上传分片大小无效。" }, { status: 413 });
  }
  const multipart = bindings().UPLOADS.resumeMultipartUpload(material.objectKey, uploadId);
  const part = await multipart.uploadPart(partNumber, bytes);
  return NextResponse.json({ partNumber: part.partNumber, etag: part.etag });
}
