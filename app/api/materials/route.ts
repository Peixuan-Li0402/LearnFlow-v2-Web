import { NextResponse } from "next/server";
import { bindings, ensureSchema } from "@/db/store";

const MAX_MATERIAL_BYTES = 20 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const form = await request.formData();
  const file = form.get("file");
  const projectId = String(form.get("projectId") || "");
  const category = String(form.get("category") || "REFERENCE");
  const materialId = String(form.get("materialId") || crypto.randomUUID());
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function" || !projectId) {
    return NextResponse.json({ error: "缺少项目或文件。" }, { status: 400 });
  }
  if (file.size > MAX_MATERIAL_BYTES) {
    return NextResponse.json({ error: "单份资料请不要超过 20MB。" }, { status: 413 });
  }

  await ensureSchema();
  const { DB, UPLOADS } = bindings();
  const safeName = file.name.replace(/[^\p{L}\p{N}._-]+/gu, "-");
  const objectKey = `${projectId}/${materialId}/${safeName}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Always persist first. Reference parsing is a separate resumable request so a
  // slow OCR/model call can never make the upload itself disappear.
  await UPLOADS.put(objectKey, bytes, {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
    customMetadata: { projectId, materialId, category },
  });
  await DB.prepare(
    `INSERT INTO materials (id, project_id, name, category, mime_type, size, object_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(materialId, projectId, file.name, category, file.type, file.size, objectKey, Date.now())
    .run();

    return NextResponse.json({ materialId, objectKey, name: file.name });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "资料上传失败，请重试。" },
      { status: 503 },
    );
  }
}
