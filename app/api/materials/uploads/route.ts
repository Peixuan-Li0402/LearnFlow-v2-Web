import { NextResponse } from "next/server";
import { bindings, ensureSchema } from "@/db/store";

const PART_SIZE = 5 * 1024 * 1024;
const MAX_SIZE = 20 * 1024 * 1024;

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as {
    projectId?: string; materialId?: string; name?: string; size?: number; mimeType?: string; category?: string;
  };
  const projectId = String(body.projectId || "");
  const materialId = String(body.materialId || "");
  const name = String(body.name || "").trim();
  const size = Number(body.size || 0);
  if (!projectId || !materialId || !name || !Number.isFinite(size) || size <= 0) {
    return NextResponse.json({ error: "资料上传参数不完整。" }, { status: 400 });
  }
  if (size > MAX_SIZE) return NextResponse.json({ error: "单份资料请不要超过 20MB。" }, { status: 413 });
  await ensureSchema();
  const { DB, UPLOADS } = bindings();
  const project = await DB.prepare("SELECT id FROM projects WHERE id = ?").bind(projectId).first();
  if (!project) return NextResponse.json({ error: "作业不存在。" }, { status: 404 });
  const safeName = name.replace(/[^\p{L}\p{N}._-]+/gu, "-");
  const objectKey = `${projectId}/${materialId}/${safeName}`;
  const multipart = await UPLOADS.createMultipartUpload(objectKey, {
    httpMetadata: { contentType: body.mimeType || "application/octet-stream" },
    customMetadata: { projectId, materialId, category: body.category || "REFERENCE" },
  });
  try {
    await DB.prepare(
      `INSERT INTO materials (id, project_id, name, category, mime_type, size, object_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET object_key=excluded.object_key, size=excluded.size`,
    ).bind(materialId, projectId, name, body.category || "REFERENCE", body.mimeType || "application/octet-stream", size, objectKey, Date.now()).run();
    return NextResponse.json({ materialId, objectKey, uploadId: multipart.uploadId, partSize: PART_SIZE }, { status: 201 });
  } catch (error) {
    await multipart.abort().catch(() => undefined);
    throw error;
  }
}
