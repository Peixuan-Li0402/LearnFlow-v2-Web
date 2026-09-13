import { NextResponse } from "next/server";
import { getCourse, getCourseGraph, saveGraph } from "@/db/course-store";
import { courseUid, type CourseGraph } from "@/lib/course-types";
import { parseImportedGraph } from "@/lib/graph-serialization";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const graph = await getCourseGraph(id);
  if (!graph) return NextResponse.json({ graph: null });
  return NextResponse.json({ graph });
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!(await getCourse(id))) return NextResponse.json({ error: "课程不存在。" }, { status: 404 });
  try {
    const body = (await request.json()) as { content?: string; format?: "json" | "markdown" };
    if (!body.content) return NextResponse.json({ error: "图谱文件内容不能为空。" }, { status: 400 });
    const imported = parseImportedGraph(body.content, body.format);
    const graphId = courseUid("graph");
    const nodeIds = new Map(imported.nodes.map((node) => [node.id, courseUid("node")]));
    const timestamp = new Date().toISOString();
    const graph: CourseGraph = {
      ...imported,
      id: graphId,
      courseId: id,
      version: Math.max(1, Number(imported.version) || 1),
      status: "READY",
      createdAt: timestamp,
      updatedAt: timestamp,
      nodes: imported.nodes.map((node) => ({
        ...node,
        id: nodeIds.get(node.id)!,
        graphId,
        courseId: id,
        chapterId: node.chapterId ? nodeIds.get(node.chapterId) : undefined,
        explanationArtifactId: undefined,
      })),
      edges: imported.edges
        .filter((edge) => nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId))
        .map((edge) => ({
          ...edge,
          id: courseUid("edge"),
          graphId,
          courseId: id,
          sourceNodeId: nodeIds.get(edge.sourceNodeId)!,
          targetNodeId: nodeIds.get(edge.targetNodeId)!,
        })),
    };
    return NextResponse.json({ graph: await saveGraph(graph) }, { status: 201 });
  } catch (reason) {
    return NextResponse.json({ error: reason instanceof Error ? reason.message : "图谱导入失败。" }, { status: 400 });
  }
}
