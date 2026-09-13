import { NextResponse } from "next/server";
import { bindings, ensureSchema } from "@/db/store";

type UploadedPart = { partNumber: number; etag: string };
type RouteContext = { params: Promise<{ id: string; uploadId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { id, uploadId } = await context.params;
  const body = await request.json().catch(() => ({})) as { parts?: UploadedPart[] };
  const parts = (body.parts || []).filter((part) => Number.isInteger(part.partNumber) && part.partNumber > 0 && part.etag).sort((a, b) => a.partNumber - b.partNumber);
  if (!parts.length) return NextResponse.json({ error: "没有可合并的上传分片。" }, { status: 400 });
  await ensureSchema();
  const row = await bindings().DB.prepare("SELECT object_key FROM materials WHERE id = ?").bind(id).first<{ object_key: string }>();
  if (!row) return NextResponse.json({ error: "资料记录不存在。" }, { status: 404 });
  const multipart = bindings().UPLOADS.resumeMultipartUpload(row.object_key, uploadId);
  await multipart.complete(parts);
  return NextResponse.json({ materialId: id, objectKey: row.object_key });
}
