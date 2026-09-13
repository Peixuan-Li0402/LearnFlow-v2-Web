import { NextResponse } from "next/server";
import { getProject } from "@/db/store";
import {
  getCourseGraph,
  getProjectCourseId,
  listProblemKnowledgeLinks,
  saveProblemKnowledgeLinks,
} from "@/db/course-store";
import { suggestProblemKnowledgeLinks } from "@/lib/course-model";

type RouteContext = { params: Promise<{ id: string; problemId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id, problemId } = await context.params;
  const courseId = await getProjectCourseId(id);
  const graph = courseId ? await getCourseGraph(courseId) : null;
  const links = await listProblemKnowledgeLinks(id, problemId);
  return NextResponse.json({
    courseId,
    links: links.map((link) => ({ ...link, nodeTitle: graph?.nodes.find((node) => node.id === link.nodeId)?.title || "知识点" })),
  });
}

export async function POST(_request: Request, context: RouteContext) {
  const { id, problemId } = await context.params;
  const project = await getProject(id);
  if (!project) return NextResponse.json({ error: "作业项目不存在。" }, { status: 404 });
  const problem = project.problems.find((item) => item.id === problemId);
  if (!problem) return NextResponse.json({ error: "题目不存在。" }, { status: 404 });
  const courseId = await getProjectCourseId(id);
  if (!courseId) return NextResponse.json({ error: "作业尚未迁移到课程空间。" }, { status: 409 });
  const graph = await getCourseGraph(courseId);
  if (!graph) return NextResponse.json({ error: "课程图谱尚未生成。" }, { status: 409 });
  const links = await suggestProblemKnowledgeLinks(courseId, id, problemId, problem.rawText, graph);
  await saveProblemKnowledgeLinks(courseId, id, problemId, links);
  return NextResponse.json({
    courseId,
    links: links.map((link) => ({ ...link, nodeTitle: graph.nodes.find((node) => node.id === link.nodeId)?.title || "知识点" })),
  });
}
