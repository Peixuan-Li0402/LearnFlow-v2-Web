import { getCourseGraph } from "@/db/course-store";
import type { CourseGraph } from "@/lib/course-types";
import { graphToMarkdown } from "@/lib/graph-serialization";

type RouteContext = { params: Promise<{ id: string }> };

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function graphToSvg(graph: CourseGraph) {
  const nodes = [...graph.nodes].sort((a, b) => a.order - b.order);
  const width = 1600;
  const rowHeight = 48;
  const height = Math.max(500, 100 + nodes.length * rowHeight);
  const chapterIndex = new Map<string, number>();
  let chapter = 0;
  for (const node of nodes) {
    if (node.type === "CHAPTER") chapter += 1;
    chapterIndex.set(node.id, chapter);
  }
  const content = nodes.map((node, index) => {
    const x = node.type === "COURSE" ? 60 : node.type === "CHAPTER" ? 140 : 300;
    const y = 64 + index * rowHeight;
    const color = node.type === "COURSE" ? "#6941ff" : node.type === "CHAPTER" ? "#2f6feb" : "#111827";
    return `<g><circle cx="${x}" cy="${y - 5}" r="6" fill="${color}"/><text x="${x + 18}" y="${y}" font-family="Arial, 'Microsoft YaHei', sans-serif" font-size="20" fill="#111827">${escapeXml(node.title)}</text></g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#ffffff"/><text x="60" y="36" font-family="Arial, 'Microsoft YaHei', sans-serif" font-size="26" font-weight="700" fill="#111827">${escapeXml(graph.title)}</text>${content}</svg>`;
}

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const graph = await getCourseGraph(id);
  if (!graph) return new Response("课程图谱尚未生成。", { status: 404 });
  const format = new URL(request.url).searchParams.get("format") || "json";
  if (format === "markdown") {
    return new Response(graphToMarkdown(graph), {
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(graph.title)}.md` },
    });
  }
  if (format === "svg") {
    return new Response(graphToSvg(graph), {
      headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(graph.title)}.svg` },
    });
  }
  return new Response(JSON.stringify(graph, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(graph.title)}.json` },
  });
}
