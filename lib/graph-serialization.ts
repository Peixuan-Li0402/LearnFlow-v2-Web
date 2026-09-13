import type { CourseGraph, KnowledgeNode } from "@/lib/course-types";

const marker = "ZHIJIE_GRAPH_JSON";

function encodeUtf8Base64(value: string) {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeUtf8Base64(value: string) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function graphToMarkdown(graph: CourseGraph) {
  const children = new Map<string, KnowledgeNode[]>();
  for (const edge of graph.edges.filter((item) => item.type === "CONTAINS")) {
    const child = graph.nodes.find((node) => node.id === edge.targetNodeId);
    if (!child) continue;
    const list = children.get(edge.sourceNodeId) || [];
    list.push(child);
    children.set(edge.sourceNodeId, list);
  }
  const roots = graph.nodes.filter((node) => node.type === "COURSE");
  const lines: string[] = [];
  const visit = (node: KnowledgeNode, depth: number) => {
    const formula = node.formula ? ` — $${node.formula}$` : "";
    lines.push(`${"  ".repeat(depth)}- ${node.title}${formula}`);
    for (const child of (children.get(node.id) || []).sort((a, b) => a.order - b.order)) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  const portableGraph = encodeUtf8Base64(JSON.stringify(graph));
  return `# ${graph.title}\n\n${lines.join("\n")}\n\n<!-- ${marker}:${portableGraph} -->\n`;
}

export function parseImportedGraph(content: string, format?: string): CourseGraph {
  let raw: unknown;
  if (format === "markdown" || (!format && content.trimStart().startsWith("#"))) {
    const matched = content.match(new RegExp(`<!--\\s*${marker}:([A-Za-z0-9+/=]+)\\s*-->`));
    if (!matched) throw new Error("该 Markdown 不是 LearnFlow 导出的可重新导入图谱。");
    raw = JSON.parse(decodeUtf8Base64(matched[1]));
  } else {
    raw = JSON.parse(content);
  }
  if (!raw || typeof raw !== "object") throw new Error("图谱文件内容无效。");
  const graph = raw as Partial<CourseGraph>;
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || typeof graph.title !== "string") {
    throw new Error("图谱文件缺少 title、nodes 或 edges。");
  }
  return graph as CourseGraph;
}
