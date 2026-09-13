import { NextResponse } from "next/server";
import { bindings, ensureSchema } from "@/db/store";

const PART_SIZE = 5 * 1024 * 1024;
type RouteContext = { params: Promise<{ id: string; uploadId: string; partNumber: string }> };

export async function PUT(request: Request, context: RouteContext) {
  const { id, uploadId, partNumber: partText } = await context.params;
  const partNumber = Number(partText);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return NextResponse.json({ error: "分片编号无效。" }, { status: 400 });
  }
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > PART_SIZE) return NextResponse.json({ error: "上传分片大小无效。" }, { status: 413 });
  await ensureSchema();
  const row = await bindings().DB.prepare("SELECT object_key FROM materials WHERE id = ?").bind(id).first<{ object_key: string }>();
  if (!row) return NextResponse.json({ error: "资料记录不存在。" }, { status: 404 });
  const multipart = bindings().UPLOADS.resumeMultipartUpload(row.object_key, uploadId);
  const part = await multipart.uploadPart(partNumber, bytes);
  return NextResponse.json({ partNumber: part.partNumber, etag: part.etag });
}
