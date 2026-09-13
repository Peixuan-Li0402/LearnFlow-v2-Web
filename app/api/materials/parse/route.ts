import { NextResponse } from "next/server";
import { bindings, ensureSchema } from "@/db/store";
import { extractReferenceMaterialWithModel } from "@/lib/model-provider";
import { buildReferenceDigest } from "@/lib/reference-context";

function supportsVisualDocument(name: string, mimeType: string) {
  return mimeType === "application/pdf"
    || mimeType.startsWith("image/")
    || /\.(pdf|png|jpe?g|webp|bmp)$/i.test(name);
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { projectId?: string; materialId?: string };
    if (!body.projectId || !body.materialId) {
      return NextResponse.json({ error: "缺少作业或资料标识。" }, { status: 400 });
    }
    await ensureSchema();
    const { DB, UPLOADS } = bindings();
    const row = await DB.prepare(
      "SELECT project_id, name, mime_type, size, object_key FROM materials WHERE id = ? AND project_id = ?",
    ).bind(body.materialId, body.projectId).first<{
      project_id: string;
      name: string;
      mime_type: string;
      size: number;
      object_key: string;
    }>();
    if (!row) return NextResponse.json({ error: "资料记录不存在，请重新上传。" }, { status: 404 });
    const visualReady = Boolean(row.object_key && supportsVisualDocument(row.name, row.mime_type || ""));
    const cachedProjects = await DB.prepare(
      `SELECT p.data_json
       FROM materials m JOIN projects p ON p.id = m.project_id
       WHERE m.name = ? AND m.size = ? AND m.mime_type = ? AND m.id <> ?
       ORDER BY p.updated_at DESC LIMIT 5`,
    ).bind(row.name, row.size, row.mime_type, body.materialId).all<{ data_json: string }>();
    for (const cached of cachedProjects.results) {
      try {
        const parsed = JSON.parse(cached.data_json) as { materials?: Array<{ name?: string; size?: number; extractedText?: string; learningDigest?: string; status?: string }> };
        const material = parsed.materials?.find((item) => item.name === row.name && item.size === row.size && item.status === "READY" && item.extractedText?.trim());
        if (material?.extractedText) {
          return NextResponse.json({
            materialId: body.materialId,
            extractedText: material.extractedText,
            learningDigest: material.learningDigest || buildReferenceDigest(material.extractedText),
            characterCount: material.extractedText.length,
            cacheHit: true,
            understandingMode: visualReady ? "VISUAL_DOCUMENT" : "TEXT_INDEX",
            visualReady,
          });
        }
      } catch {
        // A malformed old project must not block a fresh parse.
      }
    }
    const object = await UPLOADS.get(row.object_key);
    if (!object) return NextResponse.json({ error: "资料原件不存在，请重新上传。" }, { status: 404 });
    const bytes = new Uint8Array(await object.arrayBuffer());
    const extractedText = await extractReferenceMaterialWithModel(bytes, row.name, row.mime_type || "application/octet-stream");
    if (!extractedText.trim()) throw new Error("老师资料已读取，但没有提取到可用正文。");
    return NextResponse.json({
      materialId: body.materialId,
      extractedText,
      learningDigest: buildReferenceDigest(extractedText),
      characterCount: extractedText.length,
      understandingMode: visualReady ? "VISUAL_DOCUMENT" : "TEXT_INDEX",
      visualReady,
    });
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "资料解析失败，请重试。" },
      { status: 503 },
    );
  }
}
