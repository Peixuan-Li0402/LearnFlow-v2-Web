"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Transformer } from "markmap-lib";
import { Markmap } from "markmap-view";
import type { CourseGraph, KnowledgeNode } from "@/lib/course-types";
import { mathTextToPlainLabel } from "@/lib/math-text";

function markdownLabel(value: string) {
  return mathTextToPlainLabel(value).replace(/([\[\]])/g, "\\$1");
}

function graphMarkdown(graph: CourseGraph) {
  const childMap = new Map<string, KnowledgeNode[]>();
  for (const edge of graph.edges.filter((item) => item.type === "CONTAINS")) {
    const child = graph.nodes.find((node) => node.id === edge.targetNodeId);
    if (!child) continue;
    const list = childMap.get(edge.sourceNodeId) || [];
    list.push(child);
    childMap.set(edge.sourceNodeId, list);
  }
  const root = graph.nodes.find((node) => node.type === "COURSE") || graph.nodes[0];
  if (!root) return `# ${markdownLabel(graph.title)}`;
  const lines = [`# [${markdownLabel(root.title)}](#knowledge-node-${root.id})`];
  const seen = new Set<string>([root.id]);
  const visit = (parentId: string, depth: number) => {
    const children = (childMap.get(parentId) || []).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      const supplement = child.generatedFrom === "AI_SUPPLEMENT" ? " · AI 补充" : "";
      const weight = child.examWeight >= 75 ? " · 重点" : "";
      lines.push(`${"  ".repeat(depth)}- [${markdownLabel(child.title)}${weight}${supplement}](#knowledge-node-${child.id})`);
      visit(child.id, depth + 1);
    }
  };
  visit(root.id, 1);
  return lines.join("\n");
}

export function MarkmapTree({ graph, onSelect }: { graph: CourseGraph; onSelect: (node: KnowledgeNode) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const onSelectRef = useRef(onSelect);
  const [renderError, setRenderError] = useState("");
  const markdown = useMemo(() => graphMarkdown(graph), [graph]);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    const host = hostRef.current;
    const svg = svgRef.current;
    if (!host || !svg) return;

    let disposed = false;
    let instance: Markmap | null = null;
    let fitFrame = 0;
    let userInteracted = false;
    let initialFitComplete = false;
    setRenderError("");

    const syncViewport = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.max(640, Math.round(rect.width || host.clientWidth || 640));
      const height = Math.max(500, Math.round(rect.height || host.clientHeight || 500));
      svg.setAttribute("width", String(width));
      svg.setAttribute("height", String(height));
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      return rect.width > 0 && rect.height > 0;
    };

    const fitSafely = () => {
      if (userInteracted || initialFitComplete) return;
      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => {
        if (disposed || !instance || !svg.isConnected || !syncViewport()) return;
        void instance.fit().catch(() => undefined);
      });
    };

    const resizeObserver = new ResizeObserver(() => {
      syncViewport();
      fitSafely();
    });
    resizeObserver.observe(host);

    const start = async () => {
      syncViewport();
      const transformer = new Transformer();
      const { root } = transformer.transform(markdown);

      // Course nodes only need Markmap's built-in renderer. Avoid optional
      // CDN scripts (notably webfontloader), which can reject while switching
      // views or when the network is unavailable.
      instance = new Markmap(svg, {
        autoFit: false,
        duration: 260,
        initialExpandLevel: 2,
        maxWidth: 300,
        spacingHorizontal: 90,
        spacingVertical: 10,
      });
      await instance.setData(root);
      if (!disposed) {
        await instance.fit();
        initialFitComplete = true;
      }
    };

    const handleClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const anchor = target?.closest?.("a[href*='#knowledge-node-']") as HTMLAnchorElement | null;
      if (!anchor) return;
      event.preventDefault();
      event.stopPropagation();
      userInteracted = true;
      const id = anchor.getAttribute("href")?.replace("#knowledge-node-", "");
      const node = graph.nodes.find((item) => item.id === id);
      if (node) onSelectRef.current(node);
    };
    const markInteracted = () => {
      userInteracted = true;
    };
    svg.addEventListener("click", handleClick);
    svg.addEventListener("pointerdown", markInteracted, { passive: true });
    svg.addEventListener("wheel", markInteracted, { passive: true });
    void start().catch((error) => {
      if (disposed) return;
      console.error("Markmap render failed", error);
      setRenderError("复习树暂时无法渲染，请切换到依赖图后再返回重试。");
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(fitFrame);
      resizeObserver.disconnect();
      svg.removeEventListener("click", handleClick);
      svg.removeEventListener("pointerdown", markInteracted);
      svg.removeEventListener("wheel", markInteracted);
      instance?.destroy();
      svg.replaceChildren();
    };
  }, [graph, markdown]);

  return (
    <div ref={hostRef} className="markmap-shell">
      <svg ref={svgRef} className="markmap-canvas" aria-label="课程章节复习树" />
      {renderError && <div className="markmap-error" role="alert">{renderError}</div>}
    </div>
  );
}
