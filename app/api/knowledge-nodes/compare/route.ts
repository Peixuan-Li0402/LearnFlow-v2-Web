import { NextResponse } from "next/server";
import { getCourseGraph, getKnowledgeNode, listMaterialChunks } from "@/db/course-store";
import { compareKnowledgeNodes } from "@/lib/course-model";
import { rankCourseChunks } from "@/lib/course-retrieval";

export async function POST(request: Request) {
  const body = (await request.json()) as { nodeIds?: string[] };
  const ids = [...new Set(body.nodeIds || [])].slice(0, 4);
  if (ids.length < 2) return NextResponse.json({ error: "请至少选择两个知识点。" }, { status: 400 });
  const nodes = (await Promise.all(ids.map((id) => getKnowledgeNode(id)))).filter((node) => node != null);
  if (nodes.length < 2) return NextResponse.json({ error: "部分知识点不存在。" }, { status: 404 });
  if (new Set(nodes.map((node) => node.courseId)).size !== 1) {
    return NextResponse.json({ error: "只能比较同一门课程中的知识点。" }, { status: 400 });
  }
  const courseId = nodes[0].courseId;
  const [graph, chunks] = await Promise.all([getCourseGraph(courseId), listMaterialChunks(courseId)]);
  if (!graph) return NextResponse.json({ error: "课程图谱尚未生成。" }, { status: 409 });
  const evidence = rankCourseChunks(nodes.map((node) => `${node.title} ${node.shortSummary}`).join(" "), chunks, 28, nodes.flatMap((node) => node.sourceRefs.map((ref) => ref.materialId)));
  const comparison = await compareKnowledgeNodes(nodes, graph, evidence);
  return NextResponse.json({ comparison, nodes });
}

