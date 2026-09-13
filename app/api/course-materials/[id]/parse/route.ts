import { NextResponse } from "next/server";
import { bindings } from "@/db/store";
import {
  getCourseMaterial,
  saveCourseMaterial,
  saveMaterialChunks,
  updateCourse,
} from "@/db/course-store";
import { chunkCourseMaterial, parseCourseMaterial } from "@/lib/course-model";
import { indexCourseChunksVector } from "@/lib/vector-retrieval";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const material = await getCourseMaterial(id);
  if (!material) return NextResponse.json({ error: "资料不存在。" }, { status: 404 });
  const parsing = await saveCourseMaterial({ ...material, status: "PARSING", parseProgress: 12, error: undefined, updatedAt: new Date().toISOString() });
  try {
    const contentType = request.headers.get("content-type") || "";
    const supplied = contentType.includes("application/json")
      ? await request.json().catch(() => ({})) as { extractedText?: string; pageCount?: number }
      : {};
    let parsed: { text: string; pageCount?: number };
    if (supplied.extractedText?.trim()) {
      parsed = { text: supplied.extractedText.trim(), pageCount: supplied.pageCount };
    } else {
      const object = await bindings().UPLOADS.get(material.objectKey);
      if (!object) throw new Error("R2 中没有找到原始文件。请重新上传。");
      const bytes = new Uint8Array(await object.arrayBuffer());
      parsed = await parseCourseMaterial(bytes, material, request.signal);
    }
    await saveCourseMaterial({ ...material, status: "PARSING", parseProgress: 55, error: undefined, updatedAt: new Date().toISOString() });
    const chunks = chunkCourseMaterial(material, parsed.text);
    if (!chunks.length) throw new Error("资料解析完成，但没有形成可检索的课程片段。");
    await saveMaterialChunks(material.id, material.courseId, chunks);
    await saveCourseMaterial({ ...material, status: "PARSING", parseProgress: 78, error: undefined, updatedAt: new Date().toISOString() });
    let vectorIndex = { available: false, indexed: 0 };
    try {
      vectorIndex = await indexCourseChunksVector(chunks);
    } catch {
      // D1 中的资料片段仍然可用于图谱邻域与关键词检索；向量索引可稍后重建。
    }
    await saveCourseMaterial({ ...material, status: "PARSING", parseProgress: 92, error: undefined, updatedAt: new Date().toISOString() });
    const ready = await saveCourseMaterial({
      ...material,
      status: "READY",
      parseProgress: 100,
      extractedText: parsed.text,
      pageCount: parsed.pageCount,
      error: undefined,
      updatedAt: new Date().toISOString(),
    });
    await updateCourse(material.courseId, { status: "INGESTING" });
    return NextResponse.json({ material: ready, chunkCount: chunks.length, vectorIndex });
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    const message = error instanceof Error ? error.message : "课程资料解析失败。";
    await saveCourseMaterial({
      ...(parsing || material),
      status: "ERROR",
      parseProgress: 0,
      error: message,
      updatedAt: new Date().toISOString(),
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
