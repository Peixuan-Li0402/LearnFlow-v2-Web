import {
  getCourse,
  getGraphJob,
  listMaterialChunks,
  saveGraph,
  updateCourse,
  updateGraphJob,
} from "@/db/course-store";
import { generateCourseGraph, generateCourseOutline } from "./course-model";
import type { GraphBuildJob, GraphTraceItem } from "./course-types";

export type GraphJobEvent = {
  type:
    | "material_parsed"
    | "outline_ready"
    | "node_batch_ready"
    | "edge_batch_ready"
    | "review_progress"
    | "graph_ready"
    | "error";
  job: GraphBuildJob;
  message: string;
};

function traceFor(job: GraphBuildJob, stage: string, label: string, detail: string, status: GraphTraceItem["status"]) {
  const timestamp = new Date().toISOString();
  const current = job.trace.map((item) =>
    item.status === "RUNNING" ? { ...item, status: "COMPLETED" as const, completedAt: timestamp } : item,
  );
  const existing = current.findIndex((item) => item.stage === stage);
  const next: GraphTraceItem = {
    id: existing >= 0 ? current[existing].id : `trace_${job.id}_${stage.toLowerCase()}`,
    stage,
    label,
    detail,
    status,
    startedAt: existing >= 0 ? current[existing].startedAt : timestamp,
    ...(status === "COMPLETED" || status === "ERROR" ? { completedAt: timestamp } : {}),
  };
  if (existing >= 0) current[existing] = next;
  else current.push(next);
  return current;
}

export async function runGraphBuildJob(jobId: string, emit: (event: GraphJobEvent) => void | Promise<void>) {
  let job = await getGraphJob(jobId);
  if (!job) throw new Error("图谱任务不存在。");
  const course = await getCourse(job.courseId);
  if (!course) throw new Error("课程空间不存在。");
  const chunks = await listMaterialChunks(job.courseId);
  if (!chunks.length) throw new Error("课程资料尚未解析完成。请先在课程资料中解析至少一份文件。");
  const isOutlineJob = job.stage === "BUILD_OUTLINE"
    || job.stage.startsWith("OUTLINE")
    || (job.trace.some((item) => item.stage.startsWith("OUTLINE"))
      && !job.trace.some((item) => item.stage.startsWith("GRAPH") || item.stage === "KNOWLEDGE_ATOMS"));

  const advance = async (stage: string, progress: number, label: string, detail: string, eventType: GraphJobEvent["type"]) => {
    job = (await updateGraphJob(job!.id, {
      status: "RUNNING",
      stage,
      progress,
      error: undefined,
      trace: traceFor(job!, stage, label, detail, "RUNNING"),
    }))!;
    await emit({ type: eventType, job, message: detail });
  };

  try {
    if (isOutlineJob) {
      await advance("OUTLINE_PREPARE", 12, "整理资料", "正在读取已解析的章节、公式、例题和页码来源", "material_parsed");
      await updateCourse(course.id, { status: "INGESTING" });
      await advance("OUTLINE_GENERATE", 40, "课程目录", "正在识别课程主干、章节顺序和资料冲突", "review_progress");
      const outline = await generateCourseOutline(course.name, chunks, async (stage, progress, detail, partialOutline) => {
        if (partialOutline?.sections.length) {
          await updateCourse(course.id, {
            outline: partialOutline,
            outlineConfirmed: false,
            status: "INGESTING",
          });
        }
        await advance(stage, progress, "逐份整理课件", detail, "review_progress");
      });
      await updateCourse(course.id, {
        outline,
        outlineConfirmed: false,
        status: "OUTLINE_READY",
      });
      job = (await updateGraphJob(job.id, {
        status: "AWAITING_OUTLINE_CONFIRMATION",
        stage: "OUTLINE_READY",
        progress: 100,
        trace: traceFor(job, "OUTLINE_READY", "等待确认", `已整理 ${outline.sections.length} 个一级章节`, "COMPLETED"),
      }))!;
      await emit({ type: "outline_ready", job, message: "课程目录已经整理完成，请确认后再生成完整图谱。" });
      return job;
    }

    if (!course.outline || !course.outlineConfirmed) {
      throw new Error("请先确认课程目录，再生成完整知识图谱。");
    }

    await updateCourse(course.id, { status: "GRAPH_BUILDING" });
    await advance("GRAPH_PREPARE", 18, "准备图谱", "正在根据已确认目录组织章节任务", "review_progress");
    const graph = await generateCourseGraph(
      course.id,
      course.name,
      course.outline,
      chunks,
      async (stage, progress, detail) => {
        const type: GraphJobEvent["type"] = stage === "KNOWLEDGE_ATOMS"
          ? "node_batch_ready"
          : stage === "RELATIONS" ? "edge_batch_ready" : "review_progress";
        await advance(stage, progress, stage, detail, type);
      },
    );
    await saveGraph(graph);
    await updateCourse(course.id, { status: "READY" });
    job = (await updateGraphJob(job.id, {
      status: "COMPLETED",
      stage: "GRAPH_READY",
      progress: 100,
      trace: traceFor(job, "GRAPH_READY", "图谱完成", `已生成 ${graph.nodes.length} 个节点和 ${graph.edges.length} 条关系`, "COMPLETED"),
    }))!;
    await emit({ type: "graph_ready", job, message: "章节复习树和知识依赖图已经生成。" });
    return job;
  } catch (error) {
    const message = error instanceof Error ? error.message : "图谱构建失败。";
    job = (await updateGraphJob(job.id, {
      status: "ERROR",
      stage: "ERROR",
      error: message,
      trace: traceFor(job, "ERROR", "任务失败", message, "ERROR"),
    }))!;
    await updateCourse(course.id, { status: "ERROR" });
    await emit({ type: "error", job, message });
    return job;
  }
}
