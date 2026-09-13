"use client";

import {
  ArrowLeft,
  BookOpenText,
  BrainCircuit,
  CalendarDays,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Download,
  ExternalLink,
  FileStack,
  FileText,
  FlaskConical,
  GitBranch,
  GraduationCap,
  LoaderCircle,
  MessageCircleQuestion,
  Network,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownMath } from "@/app/markdown-math";
import type {
  CourseGraph,
  CourseMaterial,
  CourseOutlineSection,
  CourseSpace,
  CourseWorkspacePayload,
  ExplanationArtifact,
  GraphBuildJob,
  KnowledgeNode,
  KnowledgeNodeType,
  ReviewRoute,
  ReviewRouteInput,
  SourceRef,
} from "@/lib/course-types";
import { extractVisualDocumentText } from "@/lib/client-pdf-vision";
import { mathTextToPlainLabel, normalizeLatexFormula, repairMathText } from "@/lib/math-text";
import { MarkmapTree } from "./markmap-tree";
import { G6KnowledgeGraph } from "./g6-knowledge-graph";

type View = "study" | "graph" | "materials";

function initialViewFromLocation(): View {
  if (typeof window === "undefined") return "materials";
  const requested = new URLSearchParams(window.location.search).get("view");
  return requested === "study" || requested === "graph" || requested === "materials" ? requested : "materials";
}
type GraphMode = "tree" | "dependency" | "review";
type ChatEntry = { role: "user" | "assistant"; content: string };
type UploadTask = {
  id: string;
  materialId?: string;
  name: string;
  phase: "UPLOADING" | "MERGING" | "PARSING" | "READY" | "ERROR" | "CANCELLED";
  progress: number;
  detail: string;
};

const wait = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = window.setTimeout(resolve, milliseconds);
  signal?.addEventListener("abort", () => {
    window.clearTimeout(timer);
    reject(new DOMException("上传已取消", "AbortError"));
  }, { once: true });
});

function isAbortError(error: unknown) {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && /abort|取消/i.test(`${error.name} ${error.message}`);
}

const nodeTypeLabels: Record<KnowledgeNodeType, string> = {
  COURSE: "课程",
  CHAPTER: "章节",
  CONCEPT: "概念",
  DEFINITION: "定义",
  THEOREM: "定理",
  FORMULA: "公式",
  METHOD: "方法",
  QUESTION_TYPE: "题型",
  EXAMPLE: "真实例题",
  WARNING: "易错点",
};

const materialCategoryLabels: Record<CourseMaterial["category"], string> = {
  COURSEWARE: "老师课件",
  TEXTBOOK: "教材",
  PAST_EXAM: "往年题",
  REFERENCE_ANSWER: "参考答案",
  NOTES: "课堂笔记",
  OTHER: "其他资料",
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

async function retryFetchJson<T>(url: string, init: RequestInit, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetchJson<T>(url, init);
    } catch (error) {
      if (isAbortError(error) || init.signal?.aborted) throw error;
      lastError = error;
      if (attempt < attempts - 1) await wait([500, 1200, 2500, 5000][attempt], init.signal || undefined);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("上传请求失败。");
}

function SourceList({ refs }: { refs: SourceRef[] }) {
  if (!refs.length) return <div className="empty-mini">暂无直接资料来源；如果是 AI 补充，界面会单独标记。</div>;
  return (
    <div className="source-list">
      {refs.map((ref, index) => (
        <a key={`${ref.materialId}-${index}`} href={`/api/course-materials/${ref.materialId}/file${ref.page || ref.locator?.match(/第\s*(\d+)\s*页/)?.[1] ? `#page=${ref.page || ref.locator?.match(/第\s*(\d+)\s*页/)?.[1]}` : ""}`} target="_blank" rel="noreferrer">
          <FileText size={15} />
          <span><strong>{ref.materialName || "查看课件原文"}</strong><small>{ref.locator || (ref.page ? `第 ${ref.page} 页` : ref.section || "原资料")}</small></span>
          <ExternalLink size={13} />
        </a>
      ))}
    </div>
  );
}

function OutlineBranch({ section, depth = 0, path = "0" }: { section: CourseOutlineSection; depth?: number; path?: string }) {
  const hasChildren = Boolean(section.children?.length);
  return (
    <div className="outline-branch" style={{ marginLeft: depth * 16 }}>
      <details open={depth === 0}>
        <summary>
          <span className={`outline-chevron${hasChildren ? "" : " is-leaf"}`}><ChevronRight size={15} /></span>
          <span className="outline-copy">
            <strong>{mathTextToPlainLabel(section.title)}</strong>
            {section.summary && <span>{mathTextToPlainLabel(section.summary)}</span>}
          </span>
          {section.sourceRefs.length > 0 && <span className="outline-source-count">{section.sourceRefs.length} 处来源</span>}
        </summary>
        {hasChildren && <div className="outline-children">{section.children.map((child, index) => <OutlineBranch key={`${path}-${child.id}-${index}`} section={child} depth={depth + 1} path={`${path}-${index}`} />)}</div>}
      </details>
    </div>
  );
}

function JobPanel({ job, onResume }: { job: GraphBuildJob; onResume: () => void }) {
  return (
    <section className="job-panel">
      <div className="job-head">
        <div><LoaderCircle className={job.status === "RUNNING" ? "spin" : ""} size={18} /><strong>{job.status === "ERROR" ? "任务遇到问题" : job.status === "COMPLETED" ? "图谱任务已完成" : "图谱任务"}</strong></div>
        {(job.status === "QUEUED" || job.status === "ERROR") && <button className="text-button" onClick={onResume}><RefreshCw size={14} />继续任务</button>}
      </div>
      <div className="job-progress"><span style={{ width: `${job.progress}%` }} /></div>
      <div className="job-progress-copy"><span>{job.stage}</span><b>{job.progress}%</b></div>
      {job.error && <div className="error-inline"><CircleAlert size={15} />{job.error}</div>}
      <details>
        <summary>执行详情</summary>
        <div className="trace-list">
          {job.trace.map((item) => (
            <div key={item.id} className={`trace-${item.status.toLowerCase()}`}>
              <span>{item.status === "COMPLETED" ? <Check size={14} /> : item.status === "ERROR" ? <CircleAlert size={14} /> : <LoaderCircle size={14} />}</span>
              <div><strong>{item.label}</strong><small>{item.detail}</small></div>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}

export function CourseWorkspace() {
  const [courses, setCourses] = useState<CourseSpace[]>([]);
  const [courseId, setCourseId] = useState("");
  const [workspace, setWorkspace] = useState<CourseWorkspacePayload | null>(null);
  const [view, setView] = useState<View>("materials");
  const [navigationReady, setNavigationReady] = useState(false);
  const [graphMode, setGraphMode] = useState<GraphMode>("tree");
  const [selectedNode, setSelectedNode] = useState<KnowledgeNode | null>(null);
  const [artifact, setArtifact] = useState<ExplanationArtifact | null>(null);
  const [relatedProblems, setRelatedProblems] = useState<Array<{ projectName: string; projectId: string; problemId: string; problem?: { index: number; title: string; rawText: string }; evidence: string }>>([]);
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [compareNodeId, setCompareNodeId] = useState("");
  const [search, setSearch] = useState("");
  const [newCourseName, setNewCourseName] = useState("");
  const [newCourseDescription, setNewCourseDescription] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [materialCategory, setMaterialCategory] = useState<CourseMaterial["category"]>("COURSEWARE");
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [visibleTypes, setVisibleTypes] = useState<Set<KnowledgeNodeType>>(new Set(Object.keys(nodeTypeLabels) as KnowledgeNodeType[]));
  const [reviewInput, setReviewInput] = useState<ReviewRouteInput>({
    examDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    dailyMinutes: 120,
    scope: "整门课程核心内容",
    reviewedNodeIds: [],
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const graphImportInput = useRef<HTMLInputElement>(null);
  const courseIdRef = useRef("");
  const workspaceRequestRef = useRef<{ id: number; controller: AbortController } | null>(null);
  const workspaceRequestSequence = useRef(0);
  const uploadControllersRef = useRef(new Map<string, AbortController>());
  const uploadFingerprintsRef = useRef(new Set<string>());
  const requestedCourseIdRef = useRef(typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("courseId") || "");
  const requestedNodeIdRef = useRef(typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("nodeId") || "");

  const graph = workspace?.graph || null;
  const nodes = useMemo(() => graph?.nodes || [], [graph]);
  const selectableNodes = useMemo(
    () => nodes.filter((node) => !["COURSE", "CHAPTER"].includes(node.type)),
    [nodes],
  );
  const searchResults = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return selectableNodes;
    return selectableNodes.filter((node) => `${node.title} ${node.shortSummary} ${(node.aliases || []).join(" ")}`.toLowerCase().includes(needle));
  }, [search, selectableNodes]);

  const loadCourses = useCallback(async () => {
    const payload = await fetchJson<{ courses: CourseSpace[] }>("/api/courses");
    setCourses(payload.courses);
    const params = new URLSearchParams(window.location.search);
    const requested = requestedCourseIdRef.current || params.get("courseId");
    if (params.get("newCourse") === "1") setShowCreate(true);
    setCourseId((current) => current || (requested && payload.courses.some((course) => course.id === requested) ? requested : payload.courses[0]?.id || ""));
    const requestedView = params.get("view");
    if (requestedView === "study" || requestedView === "graph" || requestedView === "materials") setView(requestedView);
  }, []);

  const loadWorkspace = useCallback(async (id: string) => {
    if (!id) {
      setWorkspace(null);
      return;
    }
    if (courseIdRef.current && id !== courseIdRef.current) return;
    workspaceRequestRef.current?.controller.abort();
    const requestId = ++workspaceRequestSequence.current;
    const controller = new AbortController();
    workspaceRequestRef.current = { id: requestId, controller };
    const payload = await fetchJson<CourseWorkspacePayload>(`/api/courses/${id}`, { signal: controller.signal });
    if (workspaceRequestRef.current?.id !== requestId || controller.signal.aborted || (courseIdRef.current && id !== courseIdRef.current)) return;
    setWorkspace(payload);
    const requestedNode = requestedNodeIdRef.current || new URLSearchParams(window.location.search).get("nodeId");
    const node = payload.graph?.nodes.find((item) => item.id === requestedNode)
      || payload.graph?.nodes.find((item) => !["COURSE", "CHAPTER"].includes(item.type))
      || null;
    setSelectedNode((current) => payload.graph?.nodes.find((item) => item.id === current?.id) || node);
    requestedNodeIdRef.current = "";
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- these effects hydrate and reset server-backed navigation state */
  useEffect(() => {
    setView(initialViewFromLocation());
    setNavigationReady(true);
    if (new URLSearchParams(window.location.search).get("newCourse") === "1") setShowCreate(true);
  }, []);

  useEffect(() => {
    void loadCourses().catch((reason) => setError(reason instanceof Error ? reason.message : "课程列表加载失败。"));
  }, [loadCourses]);

  useEffect(() => {
    courseIdRef.current = courseId;
    void loadWorkspace(courseId).catch((reason) => {
      if (!isAbortError(reason)) setError(reason instanceof Error ? reason.message : "课程空间加载失败。");
    });
  }, [courseId, loadWorkspace]);

  useEffect(() => () => {
    workspaceRequestRef.current?.controller.abort();
    uploadControllersRef.current.forEach((controller) => controller.abort());
  }, []);

  useEffect(() => {
    if (!navigationReady) return;
    const params = new URLSearchParams(window.location.search);
    if (courseId) params.set("courseId", courseId);
    params.set("view", view);
    if (selectedNode) params.set("nodeId", selectedNode.id);
    else params.delete("nodeId");
    window.history.replaceState(null, "", `/learn?${params.toString()}`);
  }, [courseId, selectedNode, view, navigationReady]);

  useEffect(() => {
    setArtifact(null);
    setChat([]);
    if (!selectedNode) {
      setRelatedProblems([]);
      return;
    }
    void fetchJson<{ problems: typeof relatedProblems }>(`/api/knowledge-nodes/${selectedNode.id}/related-problems`)
      .then((payload) => setRelatedProblems(payload.problems))
      .catch(() => setRelatedProblems([]));
  }, [selectedNode?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  /* eslint-enable react-hooks/set-state-in-effect */

  const createCourse = async () => {
    if (!newCourseName.trim()) return;
    setBusy("正在创建课程项目");
    setError("");
    try {
      const payload = await fetchJson<{ course: CourseSpace }>("/api/courses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newCourseName, description: newCourseDescription }),
      });
      await loadCourses();
      setCourseId(payload.course.id);
      setNewCourseName("");
      setNewCourseDescription("");
      setShowCreate(false);
      setView("materials");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "课程创建失败。");
    } finally {
      setBusy("");
    }
  };

  const removeCourse = async () => {
    if (!workspace || !window.confirm(`删除“${workspace.course.name}”以及其中的图谱、资料和作业吗？`)) return;
    setBusy("正在删除课程空间");
    try {
      await fetch(`/api/courses/${workspace.course.id}`, { method: "DELETE" });
      setCourseId("");
      setWorkspace(null);
      await loadCourses();
    } finally {
      setBusy("");
    }
  };

  const uploadMaterials = async (files: FileList | null) => {
    if (!courseId || !files?.length) return;
    const targetCourseId = courseId;
    setError("");
    const queue = Array.from(files).filter((file) => {
      const fingerprint = `${targetCourseId}:${file.name}:${file.size}:${file.lastModified}`;
      if (uploadFingerprintsRef.current.has(fingerprint)) return false;
      uploadFingerprintsRef.current.add(fingerprint);
      return true;
    });
    if (!queue.length) {
      setError("这些文件已经在上传队列中，无需重复添加。");
      return;
    }

    let cursor = 0;
    const uploadOne = async (file: File) => {
      const fingerprint = `${targetCourseId}:${file.name}:${file.size}:${file.lastModified}`;
      const taskId = `${Date.now()}-${file.name}-${Math.random().toString(16).slice(2)}`;
      const controller = new AbortController();
      uploadControllersRef.current.set(taskId, controller);
      let initialized: { material: CourseMaterial; uploadId: string; partSize: number } | null = null;
      let merged = false;
      const updateTask = (patch: Partial<UploadTask>) => {
        setUploadTasks((current) => current.map((task) => task.id === taskId ? { ...task, ...patch } : task));
      };
      setUploadTasks((current) => [...current, {
        id: taskId,
        name: file.name,
        phase: "UPLOADING",
        progress: 1,
        detail: "正在建立分片上传任务",
      }]);
      try {
        initialized = await retryFetchJson<{ material: CourseMaterial; uploadId: string; partSize: number }>(`/api/courses/${targetCourseId}/materials/uploads`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: file.name, size: file.size, mimeType: file.type, category: materialCategory }),
          signal: controller.signal,
        });
        updateTask({ materialId: initialized.material.id });
        const totalParts = Math.ceil(file.size / initialized.partSize);
        const uploadedParts: Array<{ partNumber: number; etag: string }> = [];
        let uploadedBytes = 0;

        for (let offset = 0; offset < totalParts; offset += 4) {
          const partIndexes = [offset, offset + 1, offset + 2, offset + 3].filter((index) => index < totalParts);
          const batch = await Promise.all(partIndexes.map(async (index) => {
            const start = index * initialized!.partSize;
            const end = Math.min(file.size, start + initialized!.partSize);
            const body = file.slice(start, end);
            return retryFetchJson<{ partNumber: number; etag: string }>(
              `/api/course-materials/${initialized!.material.id}/uploads/${encodeURIComponent(initialized!.uploadId)}/parts/${index + 1}`,
              { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body, signal: controller.signal },
              4,
            );
          }));
          uploadedParts.push(...batch);
          uploadedBytes += partIndexes.reduce((sum, index) => {
            const start = index * initialized!.partSize;
            return sum + Math.min(initialized!.partSize, file.size - start);
          }, 0);
          const uploadProgress = Math.min(72, Math.max(2, Math.round((uploadedBytes / file.size) * 72)));
          updateTask({ progress: uploadProgress, detail: `已上传 ${uploadedParts.length}/${totalParts} 个分片` });
        }

        updateTask({ phase: "MERGING", progress: 75, detail: "分片上传完成，正在合并文件" });
        const completed = await retryFetchJson<{ material: CourseMaterial }>(
          `/api/course-materials/${initialized.material.id}/uploads/${encodeURIComponent(initialized.uploadId)}/complete`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parts: uploadedParts }),
            signal: controller.signal,
          },
        );
        merged = true;

        updateTask({ phase: "PARSING", progress: 78, detail: "文件已保存，正在提取标题、公式与正文" });
        let polling = true;
        const poll = async () => {
          while (polling) {
            await wait(1200, controller.signal);
            try {
              const payload = await fetchJson<{ material: CourseMaterial }>(`/api/course-materials/${completed.material.id}`, { signal: controller.signal });
              if (!polling) break;
              const progress = Math.min(98, 76 + Math.round((payload.material.parseProgress / 100) * 23));
              const detail = payload.material.parseProgress >= 90
                ? "正在完成课程检索索引"
                : payload.material.parseProgress >= 70
                  ? "正在整理可检索的知识片段"
                  : "正在提取标题、公式与正文";
              updateTask({ progress, detail });
            } catch {
              // 解析主请求会返回真实错误；短暂的轮询失败不打断解析。
            }
          }
        };
        const pollingTask = poll();
        try {
          const visualFile = file.type === "application/pdf" || file.type.startsWith("image/") || /\.(pdf|png|jpe?g|webp|bmp)$/i.test(file.name);
          const extractedText = visualFile
            ? await extractVisualDocumentText(file, controller.signal, (completedPages, totalPages, phase) => {
                const progress = phase === "recognize"
                  ? Math.min(97, 89 + Math.round((completedPages / totalPages) * 8))
                  : Math.min(89, 78 + Math.round((completedPages / totalPages) * 11));
                updateTask({
                  progress,
                  detail: phase === "recognize"
                    ? `千问正在阅读页面 ${completedPages}/${totalPages}`
                    : `正在准备视觉页面 ${completedPages}/${totalPages}`,
                });
              })
            : undefined;
          await retryFetchJson(`/api/course-materials/${completed.material.id}/parse`, {
            method: "POST",
            ...(extractedText
              ? {
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ extractedText }),
                }
              : {}),
            signal: controller.signal,
          }, 2);
        } finally {
          polling = false;
          await pollingTask.catch((error) => {
            if (!isAbortError(error)) throw error;
          });
        }
        updateTask({ phase: "READY", progress: 100, detail: "上传和解析完成" });
      } catch (reason) {
        if (isAbortError(reason)) {
          updateTask({ phase: "CANCELLED", progress: merged ? 100 : 0, detail: merged ? "已停止等待解析，文件已安全保存" : "上传已取消" });
        } else {
          const message = reason instanceof Error ? reason.message : `${file.name} 处理失败。`;
          setError(message);
          updateTask({ phase: "ERROR", progress: 100, detail: message });
        }
        if (initialized && !merged) {
          await fetch(`/api/course-materials/${initialized.material.id}/uploads/${encodeURIComponent(initialized.uploadId)}`, { method: "DELETE" }).catch(() => undefined);
        }
      } finally {
        uploadControllersRef.current.delete(taskId);
        uploadFingerprintsRef.current.delete(fingerprint);
      }
    };

    const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (cursor < queue.length) {
        const file = queue[cursor];
        cursor += 1;
        await uploadOne(file);
      }
    });
    await Promise.all(workers);
    if (courseIdRef.current === targetCourseId) await loadWorkspace(targetCourseId).catch((reason) => {
      if (!isAbortError(reason)) setError(reason instanceof Error ? reason.message : "资料列表刷新失败。");
    });
  };

  const cancelUpload = (taskId: string) => {
    uploadControllersRef.current.get(taskId)?.abort();
  };

  const dismissUpload = (taskId: string) => {
    uploadControllersRef.current.get(taskId)?.abort();
    uploadControllersRef.current.delete(taskId);
    setUploadTasks((current) => current.filter((task) => task.id !== taskId));
  };

  const parseMaterial = async (material: CourseMaterial) => {
    setBusy(`正在重新解析 ${material.name}`);
    setError("");
    try {
      await fetchJson(`/api/course-materials/${material.id}/parse`, { method: "POST" });
      await loadWorkspace(courseId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "资料解析失败。");
    } finally {
      setBusy("");
    }
  };

  const removeMaterial = async (material: CourseMaterial) => {
    if (!window.confirm(`删除“${material.name}”吗？依赖这份资料的图谱节点会被标记为需要重新核验。`)) return;
    setBusy(`正在删除 ${material.name}`);
    setError("");
    try {
      uploadTasks.filter((task) => task.materialId === material.id).forEach((task) => {
        uploadControllersRef.current.get(task.id)?.abort();
      });
      await fetchJson(`/api/course-materials/${material.id}`, { method: "DELETE" });
      setUploadTasks((current) => current.filter((task) => task.materialId !== material.id));
      await loadWorkspace(courseId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "资料删除失败。");
    } finally {
      setBusy("");
    }
  };

  const consumeJobStream = async (jobId: string) => {
    const response = await fetch(`/api/graph-jobs/${jobId}/run`, { method: "POST" });
    if (!response.ok || !response.body) throw new Error(await response.text());
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (data) {
          const payload = JSON.parse(data) as { job?: GraphBuildJob; message?: string };
          const nextJob = payload.job;
          if (nextJob) setWorkspace((current) => current ? { ...current, latestJob: nextJob } : current);
          if (payload.message) setBusy(payload.message);
        }
        split = buffer.indexOf("\n\n");
      }
    }
    await loadWorkspace(courseId);
  };

  const startJob = async (action: "outline" | "graph") => {
    if (!courseId) return;
    setError("");
    setBusy(action === "outline" ? "正在启动课程目录 Agent" : "正在启动知识图谱 Agent");
    try {
      const payload = await fetchJson<{ job: GraphBuildJob }>(`/api/courses/${courseId}/graph/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      setWorkspace((current) => current ? { ...current, latestJob: payload.job } : current);
      await consumeJobStream(payload.job.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "图谱任务启动失败。");
    } finally {
      setBusy("");
    }
  };

  const resumeJob = async () => {
    if (!workspace?.latestJob) return;
    setBusy("正在恢复图谱任务");
    try {
      await consumeJobStream(workspace.latestJob.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "任务恢复失败。");
    } finally {
      setBusy("");
    }
  };

  const confirmOutline = async () => {
    if (!courseId) return;
    setBusy("正在确认课程目录");
    try {
      await fetchJson(`/api/courses/${courseId}/graph/outline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outline: workspace?.course.outline }),
      });
      await loadWorkspace(courseId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "课程目录确认失败。");
    } finally {
      setBusy("");
    }
  };

  const selectNode = useCallback((node: KnowledgeNode) => {
    setSelectedNode(node);
  }, []);

  const openNodeStudy = (node: KnowledgeNode) => {
    selectNode(node);
    setView("study");
  };

  const loadExplanation = async (refresh = false) => {
    if (!selectedNode) return;
    setBusy(`正在整理“${selectedNode.title}”的完整讲解`);
    setError("");
    try {
      const payload = await fetchJson<{ artifact: ExplanationArtifact }>(`/api/knowledge-nodes/${selectedNode.id}/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh }),
      });
      setArtifact(payload.artifact);
      await loadWorkspace(courseId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "知识讲解生成失败。");
    } finally {
      setBusy("");
    }
  };

  const askKnowledge = async (question = chatInput) => {
    if (!selectedNode || !question.trim() || busy) return;
    const userEntry: ChatEntry = { role: "user", content: question.trim() };
    const nextHistory = [...chat, userEntry];
    setChat(nextHistory);
    setChatInput("");
    setBusy("正在整理回答");
    try {
      const payload = await fetchJson<{ answer: string }>(`/api/knowledge-nodes/${selectedNode.id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history: chat }),
      });
      setChat([...nextHistory, { role: "assistant", content: payload.answer }]);
      await loadWorkspace(courseId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "知识问答失败。");
    } finally {
      setBusy("");
    }
  };

  const compareCurrentNode = async () => {
    if (!selectedNode || !compareNodeId || busy) return;
    const compared = selectableNodes.find((node) => node.id === compareNodeId);
    if (!compared) return;
    const question = `比较“${selectedNode.title}”与“${compared.title}”`;
    const userEntry: ChatEntry = { role: "user", content: question };
    setChat((current) => [...current, userEntry]);
    setBusy("正在比较两个知识点");
    try {
      const payload = await fetchJson<{ comparison: string }>("/api/knowledge-nodes/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeIds: [selectedNode.id, compared.id] }),
      });
      setChat((current) => [...current, { role: "assistant", content: payload.comparison }]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "知识点比较失败。");
    } finally {
      setBusy("");
    }
  };

  const markNode = async (status: KnowledgeNode["learningStatus"]) => {
    if (!selectedNode) return;
    const payload = await fetchJson<{ node: KnowledgeNode }>(`/api/knowledge-nodes/${selectedNode.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ learningStatus: status, evidence: ["用户在知识学习台主动标记"] }),
    });
    setSelectedNode(payload.node);
    await loadWorkspace(courseId);
  };

  const createReviewRoute = async () => {
    if (!courseId) return;
    setBusy("正在根据考试日期和知识依赖生成冲刺路线");
    setError("");
    try {
      const payload = await fetchJson<{ route: ReviewRoute }>(`/api/courses/${courseId}/review-route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reviewInput),
      });
      setWorkspace((current) => current ? { ...current, reviewRoute: payload.route } : current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "复习路线生成失败。");
    } finally {
      setBusy("");
    }
  };

  const updateReviewItem = async (itemId: string, status: "PENDING" | "DONE" | "REVIEW") => {
    await fetchJson(`/api/review-route-items/${itemId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await loadWorkspace(courseId);
  };

  const exportGraph = (format: "json" | "markdown" | "svg" | "png" | "pdf") => {
    if (!graph) return;
    if (format === "json" || format === "markdown" || format === "svg") {
      window.open(`/api/courses/${courseId}/graph/export?view=${graphMode === "dependency" ? "graph" : "tree"}&format=${format}`, "_blank");
      return;
    }
    if (format === "pdf") {
      window.print();
      return;
    }
    const canvas = document.querySelector<HTMLCanvasElement>(".g6-canvas canvas");
    if (graphMode === "dependency" && canvas) {
      const anchor = document.createElement("a");
      anchor.download = `${graph.title}.png`;
      anchor.href = canvas.toDataURL("image/png");
      anchor.click();
      return;
    }
    const svg = document.querySelector<SVGSVGElement>(".markmap-canvas");
    if (!svg) return;
    const serialized = new XMLSerializer().serializeToString(svg);
    const image = new Image();
    image.onload = () => {
      const target = document.createElement("canvas");
      target.width = Math.max(1800, Math.ceil(svg.getBoundingClientRect().width * 2));
      target.height = Math.max(1200, Math.ceil(svg.getBoundingClientRect().height * 2));
      const context = target.getContext("2d");
      if (!context) return;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, target.width, target.height);
      context.drawImage(image, 0, 0, target.width, target.height);
      const anchor = document.createElement("a");
      anchor.download = `${graph.title}.png`;
      anchor.href = target.toDataURL("image/png");
      anchor.click();
    };
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;
  };

  const importGraph = async (file: File | undefined) => {
    if (!file || !courseId) return;
    setBusy(`正在导入 ${file.name}`);
    setError("");
    try {
      const content = await file.text();
      await fetchJson(`/api/courses/${courseId}/graph`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, format: file.name.toLowerCase().endsWith(".md") ? "markdown" : "json" }),
      });
      await loadWorkspace(courseId);
      setView("graph");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "图谱导入失败。");
    } finally {
      setBusy("");
    }
  };

  const toggleType = (type: KnowledgeNodeType) => {
    setVisibleTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  return (
    <main className="course-shell">
      <aside className="course-sidebar">
        <div className="course-brand"><span><BrainCircuit size={21} /></span><div><strong>LearnFlow</strong><small>大学课程学习与期末冲刺 Agent</small></div></div>
        <Link className="homework-entry" href="/"><ArrowLeft size={16} /><span><strong>作业辅导</strong><small>逐题讲解与标准答案</small></span></Link>
        <button className="course-create-button" onClick={() => setShowCreate(true)}><Plus size={16} />新建课程项目</button>
        <label className="sidebar-caption">当前课程项目</label>
        {courses.length ? (
          <select className="course-select" value={courseId} onChange={(event) => setCourseId(event.target.value)}>
            {courses.map((course) => <option key={course.id} value={course.id}>课程项目 · {course.name}</option>)}
          </select>
        ) : <div className="course-empty-select">还没有课程</div>}
        <nav className="course-nav">
          <button className={view === "study" ? "active" : ""} onClick={() => setView("study")}><BookOpenText size={18} /><span><strong>知识学习</strong><small>从零讲清一个概念</small></span></button>
          <button className={view === "graph" ? "active" : ""} onClick={() => setView("graph")}><Network size={18} /><span><strong>复习图谱</strong><small>章节树、依赖与冲刺路线</small></span></button>
          <button className={view === "materials" ? "active" : ""} onClick={() => setView("materials")}><FileStack size={18} /><span><strong>课程资料</strong><small>课件、教材与往年题</small></span></button>
        </nav>
        <Link className="secondary-entry" href="/tools"><FlaskConical size={16} /><span><strong>工具实验室</strong><small>SymPy · 绘图 · OJ</small></span></Link>
        <div className="sidebar-spacer" />
        {workspace && <button className="danger-link" onClick={removeCourse}><Trash2 size={15} />删除当前课程</button>}
      </aside>

      <section className="course-main">
        <header className="course-topbar">
          <div><span>{workspace?.course.description || "把课程资料变成可追问、可定位的复习路径"}</span><div className="course-title-line"><b>课程项目</b><h1>{workspace?.course.name || "创建一个课程项目开始"}</h1></div></div>
          <div className="topbar-status">{busy ? <><LoaderCircle className="spin" size={16} />{busy}</> : workspace ? <><span className={`status-dot status-${workspace.course.status.toLowerCase()}`} />{workspace.course.status}</> : null}</div>
        </header>
        {error && <div className="global-error"><CircleAlert size={17} /><span>{error}</span><button onClick={() => setError("")}>×</button></div>}

        {!workspace ? (
          <section className="course-empty-state">
            <GraduationCap size={46} />
            <h2>先建立课程空间</h2>
            <p>课程空间把课件、知识图谱、期末路线和所有作业放在一起，不同课程之间完全隔离。</p>
            <button onClick={() => setShowCreate(true)}><Plus size={17} />新建课程项目</button>
          </section>
        ) : view === "materials" ? (
          <div className="workspace-scroll materials-workspace">
            <section className="workspace-heading"><div><span>01</span><div><h2>课程资料</h2><p>上传老师课件、教材、往年题和参考答案。每段知识都会保留原资料页码。</p></div></div></section>
            <section className="upload-panel">
              <div className="upload-controls">
                <select value={materialCategory} onChange={(event) => setMaterialCategory(event.target.value as CourseMaterial["category"])}>
                  {Object.entries(materialCategoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <button onClick={() => fileInput.current?.click()} disabled={Boolean(busy)}><Upload size={17} />上传课程资料</button>
                <input ref={fileInput} hidden multiple type="file" accept=".pdf,.ppt,.pptx,.doc,.docx,.png,.jpg,.jpeg,.webp,.bmp,.md,.markdown,.txt" onChange={(event) => { void uploadMaterials(event.target.files); event.target.value = ""; }} />
              </div>
              <p>支持 PDF、PPT/PPTX、Word、图片、Markdown 和 TXT。最多同时处理 2 份文件，每份文件最多并发 4 个分片；网络波动会自动退避重试，也可以随时取消。</p>
              {uploadTasks.length > 0 && (
                <div className="upload-task-list">
                  {uploadTasks.slice(-4).map((task) => (
                    <div key={task.id} className={`upload-task upload-task-${task.phase.toLowerCase()}`}>
                      <div className="upload-task-copy">
                        <strong>{task.name}</strong>
                        <span>{task.detail}</span>
                        <b>{task.progress}%</b>
                        {!["READY", "ERROR", "CANCELLED"].includes(task.phase)
                          ? <button title="取消上传" onClick={() => cancelUpload(task.id)}><X size={13} /></button>
                          : <button title="清除此记录" onClick={() => dismissUpload(task.id)}><X size={13} /></button>}
                      </div>
                      <div className="upload-task-progress"><span style={{ width: `${task.progress}%` }} /></div>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <div className="material-grid">
              {workspace.materials.map((material) => (
                <article key={material.id} className={`material-card material-${material.status.toLowerCase()}`}>
                  <div className="material-icon"><FileText size={21} /></div>
                  <div className="material-copy"><strong>{material.name}</strong><span>{materialCategoryLabels[material.category]} · {(material.size / 1024 / 1024).toFixed(1)} MB</span><small>{material.status === "READY" ? `已解析${material.pageCount ? ` · ${material.pageCount} 页` : ""}` : material.status === "UPLOADED" ? "已上传，等待解析" : material.status === "ERROR" ? material.error : `${material.parseProgress}%`}</small></div>
                  <div className="material-actions"><a href={`/api/course-materials/${material.id}/file`} target="_blank" rel="noreferrer"><ExternalLink size={14} /></a>{material.status !== "READY" && <button onClick={() => void parseMaterial(material)}><RefreshCw size={14} /></button>}<button className="material-delete" onClick={() => void removeMaterial(material)} title="删除资料"><Trash2 size={14} /></button></div>
                </article>
              ))}
              {!workspace.materials.length && <div className="empty-card"><FileStack size={30} /><strong>还没有课程资料</strong><span>先上传一份老师课件或课程 PDF。</span></div>}
            </div>

            <section className="course-assignments-panel">
              <div className="section-title"><div><span>作业</span><div><h2>项目内作业</h2><p>只有从这里创建的作业会继承当前课程项目的课件、课本、知识图谱与课程说明。</p></div></div></div>
              <div className="assignment-create-actions">
                <Link href={`/?newProject=1&courseId=${courseId}`}><Plus size={15} />新建项目内作业</Link>
              </div>
              <div className="assignment-list">
                {workspace.projects.map((item) => (
                  <Link key={item.id} href={`/?projectId=${item.id}`}>
                    <b className="assignment-card-kind">作业</b>
                    <span><strong>{item.name}</strong><small>{item.problemCount} 题 · 已完成 {item.completedCount} 题</small></span>
                    <ChevronRight size={16} />
                  </Link>
                ))}
                {!workspace.projects.length && <div className="empty-mini">当前课程还没有作业。</div>}
              </div>
            </section>

            <section className="graph-build-section">
              <div className="section-title"><div><span>02</span><div><h2>从资料生成课程结构</h2><p>先确认目录，再构建知识节点、关系、重点证据和布局。</p></div></div></div>
              {workspace.latestJob && <JobPanel job={workspace.latestJob} onResume={() => void resumeJob()} />}
              {!workspace.course.outline && (
                <button className="primary-wide" disabled={!workspace.materials.some((item) => item.status === "READY") || Boolean(busy)} onClick={() => void startJob("outline")}><Sparkles size={17} />整理课程目录</button>
              )}
              {workspace.course.outline && (
                <div className="outline-preview">
                  <div className="outline-head"><div><strong>{mathTextToPlainLabel(workspace.course.outline.title)}</strong><span>{mathTextToPlainLabel(workspace.course.outline.summary)}</span></div>{workspace.course.outlineConfirmed ? <span className="confirmed-chip"><Check size={14} />已确认</span> : null}</div>
                  {workspace.course.outline.examScopeNotes.length > 0 && <div className="outline-notes"><strong>资料中的考试线索</strong>{workspace.course.outline.examScopeNotes.map((note) => <span key={note}>{mathTextToPlainLabel(note)}</span>)}</div>}
                  {workspace.course.outline.conflicts.length > 0 && <div className="outline-conflicts"><strong>需要留意的资料冲突</strong>{workspace.course.outline.conflicts.map((note) => <span key={note}>{mathTextToPlainLabel(note)}</span>)}</div>}
                  <div className="outline-tree">{workspace.course.outline.sections.map((section, index) => <OutlineBranch key={`${section.id}-${index}`} section={section} path={String(index)} />)}</div>
                  <div className="outline-actions">
                    {!workspace.course.outlineConfirmed ? <button onClick={() => void confirmOutline()} disabled={Boolean(busy)}><Check size={16} />确认目录</button> : !workspace.graph ? <button onClick={() => void startJob("graph")} disabled={Boolean(busy)}><Network size={16} />生成完整知识图谱</button> : <button onClick={() => setView("graph")}><Network size={16} />打开复习图谱</button>}
                    <button className="secondary" onClick={() => void startJob("outline")} disabled={Boolean(busy)}><RefreshCw size={15} />重新整理</button>
                  </div>
                </div>
              )}
            </section>
          </div>
        ) : view === "graph" ? (
          <div className="graph-workspace">
            {!graph ? (
              <section className="course-empty-state compact"><Network size={42} /><h2>课程图谱尚未生成</h2><p>先到课程资料中上传课件，确认目录并运行图谱任务。</p><button onClick={() => setView("materials")}>前往课程资料</button></section>
            ) : (
              <>
                <div className="graph-toolbar">
                  <div className="segmented"><button className={graphMode === "tree" ? "active" : ""} onClick={() => setGraphMode("tree")}>章节复习树</button><button className={graphMode === "dependency" ? "active" : ""} onClick={() => setGraphMode("dependency")}>知识依赖图</button><button className={graphMode === "review" ? "active" : ""} onClick={() => setGraphMode("review")}>期末冲刺路线</button></div>
                  {graphMode !== "review" && <><label className="graph-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索知识点" /></label><button className="graph-import-button" onClick={() => graphImportInput.current?.click()}><Upload size={15} />导入</button><input ref={graphImportInput} hidden type="file" accept=".json,.md,.markdown,application/json,text/markdown" onChange={(event) => { void importGraph(event.target.files?.[0]); event.target.value = ""; }} /><div className="export-menu"><Download size={15} /><select defaultValue="" onChange={(event) => { if (event.target.value) exportGraph(event.target.value as "json" | "markdown" | "svg" | "png" | "pdf"); event.target.value = ""; }}><option value="" disabled>导出</option><option value="svg">SVG</option><option value="png">PNG</option><option value="pdf">PDF</option><option value="markdown">Markdown</option><option value="json">JSON</option></select></div></>}
                </div>
                {graphMode === "review" ? (
                  <ReviewRoutePanel graph={graph} route={workspace.reviewRoute} input={reviewInput} setInput={setReviewInput} onCreate={() => void createReviewRoute()} onUpdate={updateReviewItem} onOpenNode={openNodeStudy} busy={Boolean(busy)} />
                ) : (
                  <div className="graph-grid">
                    <section className="graph-canvas-panel">
                      {graphMode === "dependency" && <div className="type-filters">{(Object.keys(nodeTypeLabels) as KnowledgeNodeType[]).map((type) => <button key={type} className={visibleTypes.has(type) ? "active" : ""} onClick={() => toggleType(type)}>{nodeTypeLabels[type]}</button>)}</div>}
                      {search && <div className="graph-search-results">{searchResults.slice(0, 8).map((node) => <button key={node.id} onClick={() => selectNode(node)}><span>{nodeTypeLabels[node.type]}</span>{mathTextToPlainLabel(node.title)}</button>)}</div>}
                      {graphMode === "tree" ? <MarkmapTree graph={graph} onSelect={selectNode} /> : <G6KnowledgeGraph graph={graph} visibleTypes={visibleTypes} focusNodeId={selectedNode?.id} onSelect={selectNode} />}
                    </section>
                    <NodeInspector node={selectedNode} onStudy={openNodeStudy} />
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="study-workspace">
            {!graph ? (
              <section className="course-empty-state compact"><BookOpenText size={42} /><h2>先生成课程知识图谱</h2><p>知识学习台会依赖课程节点、原资料证据和相邻知识关系组织讲解。</p><button onClick={() => setView("materials")}>前往课程资料</button></section>
            ) : (
              <>
                <aside className="study-node-list">
                  <label><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索概念、公式、定理" /></label>
                  <div>{searchResults.map((node) => <button key={node.id} className={selectedNode?.id === node.id ? "active" : ""} onClick={() => selectNode(node)}><span>{nodeTypeLabels[node.type]}</span><strong>{mathTextToPlainLabel(node.title)}</strong><small>{mathTextToPlainLabel(node.shortSummary)}</small></button>)}</div>
                </aside>
                <section className="study-content">
                  {selectedNode ? (
                    <>
                      <div className="study-hero"><div><span className="node-type-chip">{nodeTypeLabels[selectedNode.type]}</span>{selectedNode.generatedFrom === "AI_SUPPLEMENT" && <span className="ai-chip">AI 补充</span>}<h2>{mathTextToPlainLabel(selectedNode.title)}</h2><MarkdownMath content={repairMathText(selectedNode.shortSummary)} className="node-summary" /></div><div className="learning-state"><button className={selectedNode.learningStatus === "UNDERSTOOD" ? "active" : ""} onClick={() => void markNode("UNDERSTOOD")}>已经理解</button><button className={selectedNode.learningStatus === "REVIEW" ? "active" : ""} onClick={() => void markNode("REVIEW")}>需要回看</button></div></div>
                      <div className="quick-prompts">{["再说白一点", "解释这个符号", "为什么想到它", "从头推导", "给我看课件原文", "考试怎么考", "直接看试卷写法"].map((prompt) => <button key={prompt} onClick={() => void askKnowledge(prompt)}>{prompt}</button>)}</div>
                      <div className="compare-control"><span>易混概念对比</span><select value={compareNodeId} onChange={(event) => setCompareNodeId(event.target.value)}><option value="">选择另一个知识点</option>{selectableNodes.filter((node) => node.id !== selectedNode.id).map((node) => <option key={node.id} value={node.id}>{mathTextToPlainLabel(node.title)}</option>)}</select><button onClick={() => void compareCurrentNode()} disabled={!compareNodeId || Boolean(busy)}>开始比较</button></div>
                      {!artifact ? (
                        <div className="explanation-placeholder"><BookOpenText size={34} /><strong>从零前置开始，完整讲清这个知识点</strong><span>讲解会覆盖直觉、定义、符号、公式条件、推导、易混概念、真实课件例题与考试写法。</span><button onClick={() => void loadExplanation(false)} disabled={Boolean(busy)}><Sparkles size={16} />生成完整讲解</button></div>
                      ) : (
                        <div className="explanation-sections">
                          <div className="explanation-toolbar"><span>已按课程资料整理</span><button onClick={() => void loadExplanation(true)}><RefreshCw size={14} />重新整理</button></div>
                          {artifact.sections.map((section) => <article key={section.key} className={`explanation-${section.key}`}><h3>{section.title}</h3><MarkdownMath content={section.content} /></article>)}
                        </div>
                      )}
                      <section className="related-panel"><h3>课程出处与真实题目</h3><div className="related-columns"><div><strong>资料来源</strong><SourceList refs={selectedNode.sourceRefs} /></div><div><strong>关联作业与往年题</strong>{relatedProblems.length ? relatedProblems.map((item) => <Link key={`${item.projectId}-${item.problemId}`} href={`/?projectId=${item.projectId}&problemId=${item.problemId}`}><span>{item.projectName}</span><strong>{item.problem ? `第 ${item.problem.index} 题 · ${item.problem.title}` : item.problemId}</strong><small>{item.evidence}</small></Link>) : <div className="empty-mini">暂时没有已经关联的真实题目。</div>}</div></div></section>
                    </>
                  ) : <div className="course-empty-state compact"><MessageCircleQuestion size={38} /><h2>选择一个知识点</h2><p>你可以从左侧搜索，也可以从复习图谱点击进入。</p></div>}
                </section>
                <aside className="study-chat">
                  <div className="study-chat-head"><MessageCircleQuestion size={17} /><strong>继续追问</strong></div>
                  <div className="study-chat-messages">{chat.length ? chat.map((entry, index) => <div key={index} className={`chat-${entry.role}`}><MarkdownMath content={entry.content} /></div>) : <div className="chat-empty">自由提问，不需要按固定步骤学习。</div>}{busy === "正在整理回答" && <div className="thinking-line"><LoaderCircle className="spin" size={15} />正在思考</div>}</div>
                  <div className="study-chat-input"><textarea value={chatInput} onChange={(event) => setChatInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void askKnowledge(); } }} placeholder="输入你没看懂的地方…" /><button onClick={() => void askKnowledge()} disabled={!chatInput.trim() || Boolean(busy)}><Send size={16} /></button><span>Enter 发送 · Shift + Enter 换行</span></div>
                </aside>
              </>
            )}
          </div>
        )}
      </section>

      {showCreate && <div className="course-modal-backdrop"><div className="course-modal"><div className="modal-icon"><GraduationCap size={22} /></div><div><h2>新建课程项目</h2><p>集中管理一门课的课件、课本、知识图谱、学习状态和项目内作业。</p></div><label>课程项目名称<input value={newCourseName} onChange={(event) => setNewCourseName(event.target.value)} placeholder="例如：概率论与数理统计" autoFocus /></label><label>补充说明（可选）<textarea value={newCourseDescription} onChange={(event) => setNewCourseDescription(event.target.value)} placeholder="例如：期末范围为前五章，重点参考老师课件" /></label><div className="modal-actions"><button className="secondary" onClick={() => setShowCreate(false)}>取消</button><button onClick={() => void createCourse()} disabled={!newCourseName.trim() || Boolean(busy)}>创建课程项目</button></div></div></div>}
    </main>
  );
}

function NodeInspector({ node, onStudy }: { node: KnowledgeNode | null; onStudy: (node: KnowledgeNode) => void }) {
  if (!node) return <aside className="node-inspector empty"><GitBranch size={26} /><p>点击节点查看知识位置、资料来源和学习入口。</p></aside>;
  return (
    <aside className="node-inspector">
      <div className="inspector-title"><span>{nodeTypeLabels[node.type]}</span>{node.generatedFrom === "AI_SUPPLEMENT" && <b>AI 补充</b>}<h3>{mathTextToPlainLabel(node.title)}</h3><MarkdownMath content={repairMathText(node.shortSummary)} className="node-summary" /></div>
      <div className="node-metrics"><div><span>重要度</span><strong>{node.importance}</strong></div><div><span>难度</span><strong>{node.difficulty}</strong></div><div><span>重点证据</span><strong>{Math.round(node.examWeight)}</strong></div></div>
      {node.formula && <div className="node-formula"><MarkdownMath content={`$$${normalizeLatexFormula(node.formula)}$$`} /></div>}
      {node.conditions?.length ? <div className="node-conditions"><strong>使用条件</strong>{node.conditions.map((condition, index) => <MarkdownMath key={`${condition}-${index}`} content={repairMathText(condition)} />)}</div> : null}
      <div className="inspector-sources"><strong>资料来源</strong><SourceList refs={node.sourceRefs} /></div>
      <button className="primary-wide" onClick={() => onStudy(node)}><BookOpenText size={16} />进入知识学习台</button>
    </aside>
  );
}

function ReviewRoutePanel({
  graph,
  route,
  input,
  setInput,
  onCreate,
  onUpdate,
  onOpenNode,
  busy,
}: {
  graph: CourseGraph;
  route: ReviewRoute | null;
  input: ReviewRouteInput;
  setInput: (input: ReviewRouteInput) => void;
  onCreate: () => void;
  onUpdate: (id: string, status: "PENDING" | "DONE" | "REVIEW") => Promise<void>;
  onOpenNode: (node: KnowledgeNode) => void;
  busy: boolean;
}) {
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  return (
    <div className="review-workspace">
      <section className="review-form">
        <div><CalendarDays size={22} /><h2>期末冲刺路线</h2><p>按老师证据、往年题、知识前置和你的学习状态压缩复习，不额外生成题目。</p></div>
        <label>考试日期<input type="date" value={input.examDate} onChange={(event) => setInput({ ...input, examDate: event.target.value })} /></label>
        <label>每天可用时间<div className="input-suffix"><input type="number" min={10} step={10} value={input.dailyMinutes} onChange={(event) => setInput({ ...input, dailyMinutes: Number(event.target.value) })} /><span>分钟</span></div></label>
        <label>复习范围<textarea value={input.scope} onChange={(event) => setInput({ ...input, scope: event.target.value })} /></label>
        <label>目标分数（可选）<input type="number" min={0} max={100} value={input.targetScore || ""} onChange={(event) => setInput({ ...input, targetScore: event.target.value ? Number(event.target.value) : undefined })} /></label>
        <label>老师额外强调（可选）<textarea value={input.teacherEmphasis || ""} onChange={(event) => setInput({ ...input, teacherEmphasis: event.target.value })} /></label>
        <button onClick={onCreate} disabled={busy}><Sparkles size={16} />{route ? "重新生成路线" : "生成冲刺路线"}</button>
      </section>
      <section className="review-route">
        {route ? <><div className="route-summary"><h2>{route.summary}</h2><span><Clock3 size={15} />每天 {route.dailyMinutes} 分钟 · {route.items.length} 天</span></div><div className="route-timeline">{route.items.map((item) => <article key={item.id} className={`route-${item.status.toLowerCase()}`}><div className="route-day"><span>DAY</span><strong>{item.dayIndex}</strong><small>{item.date}</small></div><div className="route-content"><div><h3>{item.title}</h3><span>{item.estimatedMinutes} 分钟</span></div><p>{item.rationale}</p><div className="route-nodes">{item.nodeIds.map((id) => nodeMap.get(id)).filter((node): node is KnowledgeNode => Boolean(node)).map((node) => <button key={node.id} onClick={() => onOpenNode(node)}>{mathTextToPlainLabel(node.title)}<ChevronRight size={13} /></button>)}</div><div className="route-actions"><button className={item.status === "DONE" ? "active" : ""} onClick={() => void onUpdate(item.id, "DONE")}><Check size={14} />已完成</button><button className={item.status === "REVIEW" ? "active" : ""} onClick={() => void onUpdate(item.id, "REVIEW")}><RefreshCw size={14} />仍然模糊</button></div></div></article>)}</div></> : <div className="course-empty-state compact"><CalendarDays size={38} /><h2>还没有冲刺路线</h2><p>填写左侧信息后，系统会优先安排关键前置和有资料证据的高频节点。</p></div>}
      </section>
    </div>
  );
}
