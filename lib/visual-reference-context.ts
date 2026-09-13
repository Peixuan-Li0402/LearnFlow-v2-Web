import type { AgentRequest } from "./agent-types";
import { bindings } from "@/db/store";
import { getCourseMaterial } from "@/db/course-store";

const MAX_VISUAL_FILES = 2;
const MAX_VISUAL_BYTES = 20 * 1024 * 1024;

function supportsVisualDocument(name: string, mimeType: string) {
  return mimeType === "application/pdf"
    || mimeType.startsWith("image/")
    || /\.(pdf|png|jpe?g|webp|bmp)$/i.test(name);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

type Candidate = {
  materialId: string;
  name: string;
  mimeType: string;
  size: number;
  objectKey: string;
  scope: "ASSIGNMENT_ONLY" | "COURSE_PROJECT";
};

export async function loadVisualReferences(
  request: AgentRequest,
  courseContext: AgentRequest["courseContext"],
): Promise<NonNullable<AgentRequest["visualReferences"]>> {
  if (!request.problem || !["start_problem", "chat"].includes(request.action)) return [];
  // Once the hidden, verified blueprint exists, all later lesson turns render
  // from it. Do not reload and base64-encode the original PDFs on every chat.
  if (request.project?.problemSolutionBlueprints?.[request.problem.id]) return [];

  const candidates: Candidate[] = [];
  for (const material of request.project?.materials || []) {
    if (
      material.category === "ASSIGNMENT"
      || material.status !== "READY"
      || !material.objectKey
      || !supportsVisualDocument(material.name, material.mimeType)
    ) continue;
    candidates.push({
      materialId: material.id,
      name: material.name,
      mimeType: material.mimeType || "application/pdf",
      size: material.size,
      objectKey: material.objectKey,
      scope: "ASSIGNMENT_ONLY",
    });
  }

  const courseMaterialIds = [...new Set((courseContext?.references || []).map((item) => item.materialId).filter(Boolean))] as string[];
  for (const materialId of courseMaterialIds) {
    const material = await getCourseMaterial(materialId);
    if (!material || material.status !== "READY" || !supportsVisualDocument(material.name, material.mimeType)) continue;
    candidates.push({
      materialId: material.id,
      name: material.name,
      mimeType: material.mimeType || "application/pdf",
      size: material.size,
      objectKey: material.objectKey,
      scope: "COURSE_PROJECT",
    });
  }

  const selected = candidates
    .filter((item, index, all) => item.size <= MAX_VISUAL_BYTES && all.findIndex((other) => other.materialId === item.materialId) === index)
    .slice(0, MAX_VISUAL_FILES);
  if (!selected.length) return [];

  const { UPLOADS } = bindings();
  const loaded = await Promise.all(selected.map(async (item) => {
    const object = await UPLOADS.get(item.objectKey);
    if (!object) return null;
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > MAX_VISUAL_BYTES) return null;
    return {
      materialId: item.materialId,
      name: item.name,
      mimeType: item.mimeType,
      dataUrl: `data:${item.mimeType};base64,${bytesToBase64(bytes)}`,
      scope: item.scope,
    };
  }));
  return loaded.filter((item): item is NonNullable<typeof item> => Boolean(item));
}
