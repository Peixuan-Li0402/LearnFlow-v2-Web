import { NextResponse } from "next/server";
import { getCourse, listCourseMaterials, saveCourseMaterial, updateCourse } from "@/db/course-store";
import { courseUid, type CourseMaterial, type CourseMaterialCategory } from "@/lib/course-types";

type RouteContext = { params: Promise<{ id: string }> };
const allowedCategories = new Set<CourseMaterialCategory>(["COURSEWARE", "TEXTBOOK", "PAST_EXAM", "REFERENCE_ANSWER", "NOTES", "OTHER"]);

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  return NextResponse.json({ materials: await listCourseMaterials(id) });
}

export async function POST(request: Request, context: RouteContext) {
  const { id: courseId } = await context.params;
  if (!(await getCourse(courseId))) return NextResponse.json({ error: "课程空间不存在。" }, { status: 404 });
  const form = await request.formData();
  const file = form.get("file");
  const requestedCategory = String(form.get("category") || "COURSEWARE") as CourseMaterialCategory;
  const category = allowedCategories.has(requestedCategory) ? requestedCategory : "OTHER";
  if (!(file instanceof File)) return NextResponse.json({ error: "请选择课程资料文件。" }, { status: 400 });
  if (file.size > 30 * 1024 * 1024) return NextResponse.json({ error: "单个文件不能超过 30 MB。" }, { status: 413 });
  const lower = file.name.toLowerCase();
  const accepted = /\.(pdf|ppt|pptx|doc|docx|png|jpe?g|webp|bmp|md|markdown|txt)$/i.test(lower);
  if (!accepted) return NextResponse.json({ error: "支持 PDF、PPT/PPTX、Word、图片、Markdown 和 TXT。" }, { status: 415 });
  const timestamp = new Date().toISOString();
  const materialId = courseUid("material");
  const safeName = file.name.replace(/[\\/:*?"<>|]/g, "_");
  const material: CourseMaterial = {
    id: materialId,
    courseId,
    name: file.name,
    category,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    objectKey: `courses/${courseId}/materials/${materialId}/${safeName}`,
    status: "UPLOADING",
    parseProgress: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const saved = await saveCourseMaterial(material, await file.arrayBuffer());
  await updateCourse(courseId, { status: "INGESTING" });
  return NextResponse.json({ material: saved }, { status: 201 });
}

