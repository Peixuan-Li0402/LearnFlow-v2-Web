import { NextResponse } from "next/server";
import {
  getCourseGraph,
  getExplanationArtifact,
  getKnowledgeNode,
  listMaterialChunks,
  saveExplanationArtifact,
  updateNodeLearningStatus,
} from "@/db/course-store";
import { generateNodeExplanation } from "@/lib/course-model";
import { hybridEvidenceForNode } from "@/lib/course-retrieval";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { refresh?: boolean };
  const node = await getKnowledgeNode(id);
  if (!node) return NextResponse.json({ error: "知识点不存在。" }, { status: 404 });
  if (!body.refresh) {
    const cached = await getExplanationArtifact(id);
    if (cached?.sections.length) return NextResponse.json({ artifact: cached, cached: true });
  }
  const [graph, chunks] = await Promise.all([getCourseGraph(node.courseId), listMaterialChunks(node.courseId)]);
  if (!graph) return NextResponse.json({ error: "课程图谱尚未生成。" }, { status: 409 });
  const artifact = await generateNodeExplanation(node, graph, await hybridEvidenceForNode(node, graph, chunks));
  await saveExplanationArtifact(artifact);
  await updateNodeLearningStatus(node.id, "LEARNING", ["用户打开了完整知识讲解"]);
  return NextResponse.json({ artifact, cached: false });
}
