"use client";

import { useEffect, useRef, useState } from "react";
import type { Graph as G6Graph } from "@antv/g6";
import type { CourseGraph, KnowledgeNode } from "@/lib/course-types";
import { mathTextToPlainLabel } from "@/lib/math-text";

const nodeColors: Record<KnowledgeNode["type"], string> = {
  COURSE: "#5b3df5",
  CHAPTER: "#3478f6",
  CONCEPT: "#14a38b",
  DEFINITION: "#2aa876",
  THEOREM: "#d67b22",
  FORMULA: "#c24ec7",
  METHOD: "#e05b68",
  QUESTION_TYPE: "#5f6caf",
  EXAMPLE: "#8b6d4b",
  WARNING: "#dd3f3f",
};

export function G6KnowledgeGraph({
  graph,
  visibleTypes,
  focusNodeId,
  onSelect,
}: {
  graph: CourseGraph;
  visibleTypes: Set<KnowledgeNode["type"]>;
  focusNodeId?: string;
  onSelect: (node: KnowledgeNode) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<G6Graph | null>(null);
  const [renderError, setRenderError] = useState("");
  const onSelectRef = useRef(onSelect);
  const focusNodeIdRef = useRef(focusNodeId);
  const viewportRef = useRef<{
    graphId: string;
    zoom: number;
    position: ReturnType<G6Graph["getPosition"]>;
  } | null>(null);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    focusNodeIdRef.current = focusNodeId;
    const instance = instanceRef.current;
    if (!instance) return;

    const nodes = graph.nodes.filter((node) => visibleTypes.has(node.type));
    const ids = new Set(nodes.map((node) => node.id));
    const pathNodeIds = new Set<string>();
    const pathEdgeIds = new Set<string>();
    if (focusNodeId && ids.has(focusNodeId)) {
      pathNodeIds.add(focusNodeId);
      const queue = [focusNodeId];
      while (queue.length) {
        const current = queue.shift()!;
        for (const edge of graph.edges) {
          if (!["PREREQUISITE_OF", "DERIVES"].includes(edge.type)) continue;
          const neighbor = edge.targetNodeId === current
            ? edge.sourceNodeId
            : edge.sourceNodeId === current
              ? edge.targetNodeId
              : null;
          if (!neighbor || !ids.has(neighbor)) continue;
          pathEdgeIds.add(edge.id);
          if (!pathNodeIds.has(neighbor)) {
            pathNodeIds.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
    }

    const states: Record<string, string[]> = {};
    for (const node of nodes) {
      states[node.id] = node.id === focusNodeId
        ? ["selected", "highlight"]
        : pathNodeIds.has(node.id)
          ? ["highlight"]
          : focusNodeId
            ? ["inactive"]
            : [];
    }
    for (const edge of graph.edges.filter((edge) => ids.has(edge.sourceNodeId) && ids.has(edge.targetNodeId))) {
      states[edge.id] = pathEdgeIds.has(edge.id)
        ? ["highlight"]
        : focusNodeId
          ? ["inactive"]
          : [];
    }
    void instance.setElementState(states, false).catch(() => undefined);
  }, [focusNodeId, graph, visibleTypes]);

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let instance: G6Graph | null = null;
    setRenderError("");
    void import("@antv/g6").then(async ({ Graph }) => {
      if (disposed || !containerRef.current) return;
      const nodes = graph.nodes.filter((node) => visibleTypes.has(node.type));
      const ids = new Set(nodes.map((node) => node.id));
      const savedViewport = viewportRef.current?.graphId === graph.id ? viewportRef.current : null;
      const data = {
        nodes: nodes.map((node) => ({
          id: node.id,
          data: { ...node } as unknown as Record<string, unknown>,
          style: {
            size: node.type === "COURSE" ? 54 : node.type === "CHAPTER" ? 42 : 30,
            fill: nodeColors[node.type],
            stroke: node.generatedFrom === "AI_SUPPLEMENT" ? "#f59e0b" : "#ffffff",
            lineWidth: node.generatedFrom === "AI_SUPPLEMENT" ? 3 : 1.5,
            labelText: mathTextToPlainLabel(node.title),
            labelFill: "#111827",
            labelFontSize: node.type === "COURSE" ? 16 : 13,
            labelBackground: true,
            labelBackgroundFill: "rgba(255,255,255,.9)",
            labelBackgroundRadius: 5,
            labelPlacement: "bottom" as const,
          },
        })),
        edges: graph.edges
          .filter((edge) => ids.has(edge.sourceNodeId) && ids.has(edge.targetNodeId))
          .map((edge) => ({
            id: edge.id,
            source: edge.sourceNodeId,
            target: edge.targetNodeId,
            data: { ...edge } as unknown as Record<string, unknown>,
            style: {
              stroke: edge.inferred ? "#f59e0b" : edge.type === "PREREQUISITE_OF" ? "#6d5dfc" : "#b8c0cc",
              lineDash: edge.inferred ? [5, 5] : undefined,
              endArrow: edge.type === "PREREQUISITE_OF" || edge.type === "DERIVES",
              lineWidth: 1,
              opacity: edge.type === "CONTAINS" ? 0.45 : 0.8,
            },
          })),
      };
      const rendered = new Graph({
        container: containerRef.current,
        data,
        ...(savedViewport ? {} : { autoFit: "view" as const }),
        animation: false,
        layout: {
          type: "d3-force",
          manyBody: { strength: -240 },
          link: { distance: 120, strength: 0.7 },
          collide: { radius: 42 },
        },
        behaviors: ["drag-canvas", "zoom-canvas", "drag-element", "hover-activate"],
      });
      rendered.on("node:click", (event: unknown) => {
        const payload = event as { target?: { id?: string }; item?: { id?: string } };
        const id = payload.target?.id || payload.item?.id;
        const node = graph.nodes.find((item) => item.id === id);
        if (node) onSelectRef.current(node);
      });
      instance = rendered;
      await rendered.render();
      if (disposed) { rendered.destroy(); return; }
      instanceRef.current = rendered;
      if (savedViewport) {
        await rendered.zoomTo(savedViewport.zoom, false);
        await rendered.translateTo(savedViewport.position, false);
      }
      const activeFocus = focusNodeIdRef.current;
      if (!savedViewport && rendered.getZoom() < 0.65) {
        await rendered.zoomTo(0.65, false);
        const initialFocus = activeFocus && ids.has(activeFocus) ? activeFocus : nodes.find(node => node.type === "COURSE")?.id;
        if (initialFocus) await rendered.focusElement(initialFocus, false);
      }
      if (activeFocus && ids.has(activeFocus)) {
        const states: Record<string, string[]> = Object.fromEntries(nodes.map((node) => [
          node.id,
          node.id === activeFocus ? ["selected", "highlight"] : ["inactive"],
        ]));
        await rendered.setElementState(states, false);
      }
    }).catch(() => {
      if (!disposed) setRenderError("知识依赖图暂时未能加载，请切换章节复习树后重试。已生成的知识点不会丢失。");
    });
    return () => {
      disposed = true;
      if (instance) {
        viewportRef.current = {
          graphId: graph.id,
          zoom: instance.getZoom(),
          position: instance.getPosition(),
        };
      }
      if (instanceRef.current === instance) instanceRef.current = null;
      instance?.destroy();
    };
  }, [graph, visibleTypes]);

  return <div className="g6-canvas-shell"><div ref={containerRef} className="g6-canvas" aria-label="课程知识依赖图" />{renderError && <p role="alert">{renderError}</p>}</div>;
}
