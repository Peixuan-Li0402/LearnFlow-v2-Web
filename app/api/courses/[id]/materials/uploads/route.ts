import { NextResponse } from "next/server";
import { bindings } from "@/db/store";
import { getCourse, saveCourseMaterial, updateCourse } from "@/db/course-store";
import {
  allowedCourseMaterialCategories,
  COURSE_MATERIAL_MAX_SIZE,
  COURSE_MATERIAL_PART_SIZE,
  isAcceptedCourseMaterial,
  safeCourseMaterialName,
} from "@/lib/course-material-upload";
import { courseUid, type CourseMaterial, type CourseMaterialCategory } from "@/lib/course-types";

type RouteContext = { params: Promise<{ id: string }> };
type UploadInitBody = {
  name?: string;
  size?: number;
  mimeType?: string;
  category?: CourseMaterialCategory;
};

export async function POST(request: Request, context: RouteContext) {
  const { id: courseId } = await context.params;
  if (!(await getCourse(courseId))) return NextResponse.json({ error: "课程空间不存在。" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as UploadInitBody;
  const name = String(body.name || "").trim();
  const size = Number(body.size || 0);
  const requestedCategory = body.category || "COURSEWARE";
  const category = allowedCourseMaterialCategories.has(requestedCategory) ? requestedCategory : "OTHER";

  if (!name || !Number.isFinite(size) || size <= 0) {
    return NextResponse.json({ error: "文件名称或大小无效。" }, { status: 400 });
  }
  if (size > COURSE_MATERIAL_MAX_SIZE) {
    return NextResponse.json({ error: "单个课程资料不能超过 200 MB。" }, { status: 413 });
  }
  if (!isAcceptedCourseMaterial(name)) {
    return NextResponse.json({ error: "支持 PDF、PPT/PPTX、Word、图片、Markdown 和 TXT。" }, { status: 415 });
  }

  const timestamp = new Date().toISOString();
  const materialId = courseUid("material");
  const objectKey = `courses/${courseId}/materials/${materialId}/${safeCourseMaterialName(name)}`;
  const multipart = await bindings().UPLOADS.createMultipartUpload(objectKey, {
    httpMetadata: { contentType: body.mimeType || "application/octet-stream" },
  });
  const material: CourseMaterial = {
    id: materialId,
    courseId,
    name,
    category,
    mimeType: body.mimeType || "application/octet-stream",
    size,
    objectKey,
    status: "UPLOADING",
    parseProgress: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  try {
    const saved = await saveCourseMaterial(material);
    await updateCourse(courseId, { status: "INGESTING" });
    return NextResponse.json({ material: saved, uploadId: multipart.uploadId, partSize: COURSE_MATERIAL_PART_SIZE }, { status: 201 });
  } catch (error) {
    await multipart.abort().catch(() => undefined);
    throw error;
  }
}
