import type { CourseGraph, KnowledgeNode, MaterialChunk } from "./course-types";
import { queryCourseVector } from "./vector-retrieval";

function tokenize(text: string) {
  const compact = text.toLowerCase();
  const latin = compact.match(/[a-z0-9_]{2,}/g) || [];
  const chinese = compact.match(/[\u3400-\u9fff]{2,8}/g) || [];
  const phrases: string[] = [];
  for (const value of chinese) {
    phrases.push(value);
    for (let size = 2; size <= Math.min(4, value.length); size += 1) {
      for (let index = 0; index <= value.length - size; index += 1) phrases.push(value.slice(index, index + size));
    }
  }
  return [...new Set([...latin, ...phrases])];
}

export function rankCourseChunks(query: string, chunks: MaterialChunk[], limit = 20, preferredMaterialIds: string[] = []) {
  const tokens = tokenize(query);
  const preferred = new Set(preferredMaterialIds);
  return chunks
    .map((chunk) => {
      const heading = chunk.heading.toLowerCase();
      const text = chunk.text.toLowerCase();
      let score = preferred.has(chunk.materialId) ? 8 : 0;
      for (const token of tokens) {
        if (heading.includes(token)) score += 4;
        const occurrences = text.split(token).length - 1;
        score += Math.min(occurrences, 4);
      }
      return { chunk, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.sequence - b.chunk.sequence)
    .slice(0, limit)
    .map(({ chunk }) => chunk);
}

export function evidenceForNode(node: KnowledgeNode, graph: CourseGraph, chunks: MaterialChunk[], limit = 24) {
  const connectedIds = new Set(
    graph.edges
      .filter((edge) => edge.sourceNodeId === node.id || edge.targetNodeId === node.id)
      .flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId]),
  );
  const connectedTitles = graph.nodes.filter((item) => connectedIds.has(item.id)).map((item) => item.title);
  const query = [node.title, node.shortSummary, ...(node.aliases || []), ...(node.conditions || []), ...connectedTitles].join(" ");
  return rankCourseChunks(query, chunks, limit, node.sourceRefs.map((ref) => ref.materialId));
}

export async function hybridEvidenceForNode(node: KnowledgeNode, graph: CourseGraph, chunks: MaterialChunk[], limit = 24) {
  const local = evidenceForNode(node, graph, chunks, limit);
  const query = [node.title, node.shortSummary, ...(node.aliases || []), ...(node.conditions || [])].join(" ");
  let vectorIds: string[] = [];
  try {
    vectorIds = await queryCourseVector(node.courseId, query, limit);
  } catch {
    vectorIds = [];
  }
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const merged = [...vectorIds.map((id) => byId.get(id)).filter((chunk): chunk is MaterialChunk => Boolean(chunk)), ...local];
  return merged.filter((chunk, index, all) => all.findIndex((item) => item.id === chunk.id) === index).slice(0, limit);
}
