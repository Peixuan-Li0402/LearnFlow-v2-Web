import type { AgentRequest } from "./agent-types";
import { rankCourseChunks } from "./course-retrieval";
import { getCourse, getCourseGraph, listCourseMaterials, listMaterialChunks } from "@/db/course-store";

const MAX_REFERENCE_CHARS = 2_400;
const MAX_REFERENCES = 4;
const MAX_KNOWLEDGE_NODES = 10;

function queryFor(request: AgentRequest) {
  return [
    request.problem?.title,
    request.problem?.rawText,
    request.message,
    request.project?.selectedMethod,
  ].filter(Boolean).join("\n");
}

function compactText(value: string, limit = MAX_REFERENCE_CHARS) {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

export async function buildCourseAgentContext(request: AgentRequest): Promise<AgentRequest["courseContext"]> {
  const courseId = request.project?.courseId?.trim();
  if (!courseId) return undefined;

  const [course, materials, chunks, graph] = await Promise.all([
    getCourse(courseId),
    listCourseMaterials(courseId),
    listMaterialChunks(courseId),
    getCourseGraph(courseId),
  ]);
  if (!course) return undefined;

  const query = queryFor(request);
  const materialById = new Map(materials.map((material) => [material.id, material]));
  const rankedChunks = rankCourseChunks(query, chunks, MAX_REFERENCES);
  const selectedChunks = rankedChunks.length ? rankedChunks : chunks.slice(0, MAX_REFERENCES);
  const references = selectedChunks.map((chunk) => {
    const material = materialById.get(chunk.materialId);
    const locator = chunk.page ? `第 ${chunk.page} 页` : chunk.slide ? `第 ${chunk.slide} 张幻灯片` : chunk.heading;
    return {
      name: `${material?.name || chunk.sourceRef.materialName}${locator ? ` · ${locator}` : ""}`,
      category: "COURSE_MATERIAL" as const,
      text: compactText(chunk.text),
      materialId: chunk.materialId,
      page: chunk.page,
      slide: chunk.slide,
    };
  });

  if (!references.length) {
    for (const material of materials) {
      if (material.status !== "READY" || !material.extractedText?.trim()) continue;
      references.push({
        name: material.name,
        category: "COURSE_MATERIAL",
        text: compactText(material.extractedText),
        materialId: material.id,
        page: undefined,
        slide: undefined,
      });
      if (references.length >= MAX_REFERENCES) break;
    }
  }

  const queryLower = query.toLowerCase();
  const graphNodes = graph?.nodes || [];
  const matchedNodes = graphNodes.filter((node) => {
    const terms = [node.title, ...(node.aliases || [])].map((term) => term.trim().toLowerCase()).filter(Boolean);
    return terms.some((term) => queryLower.includes(term));
  });
  const importantNodes = graphNodes.filter((node) => node.importance === "CORE" || node.importance === "IMPORTANT");
  const knowledgeNodes = [...matchedNodes, ...importantNodes]
    .filter((node, index, all) => all.findIndex((item) => item.id === node.id) === index)
    .slice(0, MAX_KNOWLEDGE_NODES)
    .map((node) => ({
      id: node.id,
      title: node.title,
      type: node.type,
      shortSummary: node.shortSummary,
      conditions: node.conditions,
    }));

  return {
    courseId,
    courseName: course.name,
    courseDescription: course.description,
    references,
    knowledgeNodes,
  };
}
