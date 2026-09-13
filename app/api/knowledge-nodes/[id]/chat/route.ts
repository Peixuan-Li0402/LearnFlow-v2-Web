import { NextResponse } from "next/server";
import { getCourseGraph, getKnowledgeNode, listMaterialChunks, updateNodeLearningStatus } from "@/db/course-store";
import { answerKnowledgeQuestion } from "@/lib/course-model";
import { hybridEvidenceForNode } from "@/lib/course-retrieval";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const body = (await request.json()) as {
    question?: string;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
  };
  if (!body.question?.trim()) return NextResponse.json({ error: "问题不能为空。" }, { status: 400 });
  const node = await getKnowledgeNode(id);
  if (!node) return NextResponse.json({ error: "知识点不存在。" }, { status: 404 });
  const [graph, chunks] = await Promise.all([getCourseGraph(node.courseId), listMaterialChunks(node.courseId)]);
  if (!graph) return NextResponse.json({ error: "课程图谱尚未生成。" }, { status: 409 });
  const answer = await answerKnowledgeQuestion(node, graph, body.question, await hybridEvidenceForNode(node, graph, chunks), body.history || []);
  await updateNodeLearningStatus(node.id, "LEARNING", [`用户追问：${body.question.slice(0, 100)}`]);
  return NextResponse.json({ answer });
}
