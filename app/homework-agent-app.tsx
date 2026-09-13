"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  ArchiveRestore,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Download,
  FileSearch,
  History,
  LoaderCircle,
  Menu,
  MessageCircleQuestion,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCcw,
  Send,
  Upload,
  UserRound,
  X,
  Zap,
} from "lucide-react";
import type {
  AgentRequest,
  AgentResponse,
  AnswerBlock,
  ChatMessage,
  KnowledgeCheckpoint,
  Material,
  Problem,
  ProjectState,
} from "@/lib/agent-types";
import { uid } from "@/lib/agent-types";
import type { CourseSpace } from "@/lib/course-types";
import { emptyProject } from "@/lib/empty-project";
import { normalizeAgentResponse, normalizeProblems, normalizeProjectState, repairModelText } from "@/lib/normalize-agent";
import { extractVisualDocumentText } from "@/lib/client-pdf-vision";
import { buildReferenceDigest } from "@/lib/reference-context";
import { mathTextToPlainLabel } from "@/lib/math-text";

const MarkdownMath = dynamic(
  () => import("@/app/markdown-math").then((module) => module.MarkdownMath),
  { ssr: false, loading: () => <span className="rich-text-loading">正在排版…</span> },
);

const now = () => new Date().toISOString();

const statusLabels: Record<string, string> = {
  NOT_STARTED: "未开始",
  PREPARING: "准备中",
  TEACHING: "讲解中",
  MISSING_INFO: "待补充",
  COMPLETED: "已完成",
  SKIPPED: "已跳过",
  NEEDS_REVIEW: "存在疑点",
  PENDING: "尚未生成",
  GENERATED: "已生成",
  VERIFIED: "已质检",
  COMMITTED: "已发布",
  TEACHING_BLOCK: "讲解中",
  SKIPPED_TEACHING: "已跳过讲解",
  ROLLED_BACK: "已回退",
  INVALIDATED: "受回退影响",
};

function isAbortError(error: unknown) {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && /abort/i.test(`${error.name} ${error.message}`);
}

const requestDelay = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = window.setTimeout(resolve, milliseconds);
  signal?.addEventListener("abort", () => {
    window.clearTimeout(timer);
    reject(new DOMException("请求已取消", "AbortError"));
  }, { once: true });
});

async function fetchWithRetry(input: RequestInfo | URL, init: RequestInit, attempts = 3) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (response.ok || (response.status < 500 && ![408, 425, 429].includes(response.status))) return response;
      if (attempt === attempts - 1) return response;
      lastError = new Error(`请求失败（${response.status}）`);
    } catch (error) {
      if (isAbortError(error) || init.signal?.aborted) throw error;
      lastError = error;
    }
    if (attempt < attempts - 1) await requestDelay([500, 1200, 2400][attempt], init.signal || undefined);
  }
  throw lastError instanceof Error ? lastError : new Error("请求失败，请重试。");
}

async function agentCall(payload: AgentRequest, signal?: AbortSignal): Promise<AgentResponse & { warning?: string }> {
  const response = await fetch("/api/agent", {
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(160_000)]),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = (await response.json()) as AgentResponse & { error?: string };
  if (!response.ok) throw new Error(result.error || "千问暂时无法响应");
  return normalizeAgentResponse(result);
}

function mergeBlocks(current: AnswerBlock[], incoming: AnswerBlock[] | undefined, problemId: string) {
  if (!incoming?.length) return current;
  const unrelated = current.filter((block) => block.problemId !== problemId);
  const related = [...current.filter((block) => block.problemId === problemId)];
  for (const next of incoming) {
    const index = related.findIndex((item) => item.type === next.type);
    if (index >= 0) related[index] = { ...related[index], ...next, id: related[index].id };
    else related.push(next);
  }
  return [...unrelated, ...related.sort((a, b) => a.order - b.order)];
}

function makeMessage(role: ChatMessage["role"], content: string, stage?: ChatMessage["stage"]): ChatMessage {
  return { id: uid("message"), role, content, stage, createdAt: now() };
}

function inferInteraction(message: string): AgentRequest["interaction"] {
  if (/^(继续|下一步|接着讲)[。！! ]*$/.test(message)) return { kind: "CONTINUE" };
  return { kind: "FREEFORM" };
}

function messageFingerprint(content: string) {
  return content.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, "").slice(0, 1600);
}

function repeatsLastAssistant(content: string | undefined, messages: ChatMessage[]) {
  if (!content) return false;
  const previous = [...messages].reverse().find((message) => message.role === "assistant");
  return !!previous && messageFingerprint(previous.content) === messageFingerprint(content);
}

function estimatePdfSeconds(file: File) {
  const megabytes = file.size / (1024 * 1024);
  return Math.min(180, Math.max(45, Math.round(50 + megabytes * 18)));
}

function formatEstimate(seconds: number) {
  if (seconds < 60) return `约 ${Math.max(5, Math.ceil(seconds / 5) * 5)} 秒`;
  const minutes = Math.ceil(seconds / 30) / 2;
  return `约 ${minutes} 分钟`;
}

function createProjectState(name: string, problems: Problem[]): ProjectState {
  return {
    runtimeVersion: "model-v1",
    conversationVersion: "per-problem-v1",
    id: uid("project"),
    name,
    status: problems.length ? "AWAITING_CONFIRMATION" : "CREATED",
    currentProblemId: problems[0]?.id || null,
    teachingStage: "READING_PROBLEM",
    selectedMethod: problems.length ? "等待题目确认" : "",
    progress: 0,
    responseMode: "deep",
    problems: normalizeProblems(problems),
    materials: [],
    answerBlocks: [],
    teachingMessages: [],
    sideMessages: [],
    knowledgeCheckpoints: [],
    problemTeachingMessages: {},
    problemSideMessages: {},
    problemKnowledgeCheckpoints: {},
    problemTeachingStages: {},
    problemSelectedMethods: {},
    problemProgress: {},
    problemSolutionBlueprints: {},
    memories: [],
    checkpoints: [],
    rollbackPreview: null,
    answerVersion: 1,
    updatedAt: now(),
  };
}

function contextForProblem(project: ProjectState, problemId: string): ProjectState {
  return {
    ...project,
    teachingStage: project.problemTeachingStages?.[problemId] || "READING_PROBLEM",
    selectedMethod: project.problemSelectedMethods?.[problemId] || "",
    progress: project.problemProgress?.[problemId] || 0,
    teachingMessages: project.problemTeachingMessages?.[problemId] || [],
    sideMessages: project.problemSideMessages?.[problemId] || [],
    knowledgeCheckpoints: project.problemKnowledgeCheckpoints?.[problemId] || [],
    answerBlocks: project.answerBlocks.filter((block) => block.problemId === problemId),
  };
}

function normalizeProjectForRelease(project: ProjectState): ProjectState {
  const normalized = normalizeProjectState(project);
  const problemById = new Map(normalized.problems.map((problem) => [problem.id, problem]));
  const problemTeachingMessages = Object.fromEntries(
    Object.entries(normalized.problemTeachingMessages || {}).map(([problemId, messages]) => {
      const rawProblem = problemById.get(problemId)?.rawText || "";
      const cleaned = messages
        .filter((message) => {
          if (message.role !== "assistant") return true;
          // Old persisted turns may contain the known OCR corruption (for
          // example, a sample space Ω rewritten as θ or \bigcup mangled into
          // `igcup`). Do not show those turns after reload; a fresh answer is
          // generated from the verified blueprint when the learner asks.
          const legacyCorruption = /igcup|igcap|orall/.test(message.content)
            || (/样本空间[\s\S]{0,160}θ\s*=/.test(message.content) && /Ω|样本空间|事件域/.test(rawProblem));
          return !legacyCorruption;
        })
        .map((message) => ({ ...message, content: repairModelText(message.content) }));
      return [problemId, cleaned];
    }),
  );
  const teachingMessages = normalized.teachingMessages
    .filter((message) => !/当前未配置|结构化演示引擎|Agent 暂时/.test(message.content))
    .map((message) => {
      if (/已识别\s*\d+\s*道题/.test(message.content)) {
        return { ...message, content: `题目已经整理好。我们从当前题开始。` };
      }
      if (/左侧答案会随着讲解里程碑/.test(message.content)) {
        return { ...message, content: "先看已知条件和题目目标，再从第一步开始。" };
      }
      return message;
    });
  return {
    ...normalized,
    // PREPARING only describes an in-flight browser request. After a reload
    // that request no longer exists, so recover the problem instead of showing
    // a permanent "准备中" state.
    problems: normalized.problems.map((problem) => problem.status === "PREPARING"
      ? { ...problem, status: "NOT_STARTED" as const }
      : problem),
    teachingMessages,
    problemTeachingMessages,
    sideMessages: normalized.sideMessages.filter(
      (message) => !/这里可以随时问基础概念|这个解释只用于当前对照/.test(message.content),
    ),
    knowledgeCheckpoints: normalized.teachingStage === "DONE"
      ? normalized.knowledgeCheckpoints.filter((checkpoint) => checkpoint.status !== "PENDING")
      : normalized.knowledgeCheckpoints,
  };
}

export function HomeworkAgentApp() {
  const [courses, setCourses] = useState<CourseSpace[]>([]);
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [project, setProject] = useState<ProjectState>(emptyProject);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sideAssistantOpen, setSideAssistantOpen] = useState(true);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectCourseId, setNewProjectCourseId] = useState("");
  const [newProjectName, setNewProjectName] = useState("微积分作业");
  const [assignmentText, setAssignmentText] = useState("");
  const [newProjectFile, setNewProjectFile] = useState<File | null>(null);
  const [referenceFiles, setReferenceFiles] = useState<File[]>([]);
  const [newProjectPdfText, setNewProjectPdfText] = useState("");
  const [newProjectProblems, setNewProjectProblems] = useState<Problem[]>([]);
  const [pdfSummary, setPdfSummary] = useState("");
  const [pdfParsing, setPdfParsing] = useState(false);
  const [pdfProgress, setPdfProgress] = useState(0);
  const [pdfEstimateSeconds, setPdfEstimateSeconds] = useState(0);
  const [pdfStartedAt, setPdfStartedAt] = useState(0);
  const [pdfRemainingSeconds, setPdfRemainingSeconds] = useState(0);
  const [mainInput, setMainInput] = useState("");
  const [sideInput, setSideInput] = useState("");
  const [rollbackMode, setRollbackMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mainThinking, setMainThinking] = useState(false);
  const [sideThinking, setSideThinking] = useState(false);
  const [toast, setToast] = useState("");
  const [knowledgeAnswers, setKnowledgeAnswers] = useState<Record<string, KnowledgeCheckpoint["answer"]>>({});
  const [knowledgeNote, setKnowledgeNote] = useState("");
  const [knowledgeLinks, setKnowledgeLinks] = useState<Array<{ nodeId: string; nodeTitle: string; relevance: number; evidence: string }>>([]);
  const [knowledgeCourseId, setKnowledgeCourseId] = useState("");
  const [knowledgeLinking, setKnowledgeLinking] = useState(false);
  const [assignmentUpload, setAssignmentUpload] = useState<{ projectId: string; fileName: string; startedAt: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const modalFileInput = useRef<HTMLInputElement>(null);
  const referenceFileInput = useRef<HTMLInputElement>(null);
  const currentReferenceInput = useRef<HTMLInputElement>(null);
  const mainInputRef = useRef<HTMLTextAreaElement>(null);
  const sideInputRef = useRef<HTMLTextAreaElement>(null);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const sideMessageEndRef = useRef<HTMLDivElement>(null);
  const hydrated = useRef(false);
  const knowledgeLinkAttempts = useRef(new Set<string>());
  const projectRef = useRef(project);
  const mainRequestRef = useRef<{ id: number; controller: AbortController } | null>(null);
  const sideRequestRef = useRef<{ id: number; controller: AbortController } | null>(null);
  const problemRequestRef = useRef<{ id: number; problemId: string; controller: AbortController } | null>(null);
  const problemSelectionTimerRef = useRef<number | null>(null);
  const knowledgeLinkRequestRef = useRef<AbortController | null>(null);
  const pdfRequestRef = useRef<{ id: number; fingerprint: string; controller: AbortController } | null>(null);
  const assignmentUploadRequestRef = useRef<{ id: number; projectId: string; controller: AbortController } | null>(null);
  const referenceParseJobsRef = useRef(new Set<string>());
  const requestSequence = useRef(0);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  const currentProblem = useMemo(
    () => project.problems.find((problem) => problem.id === project.currentProblemId) || project.problems[0],
    [project],
  );
  const currentProblemId = currentProblem?.id;
  const currentBlocks = useMemo(
    () => project.answerBlocks.filter((block) => block.problemId === currentProblem?.id).sort((a, b) => a.order - b.order),
    [project.answerBlocks, currentProblem?.id],
  );
  const visibleBlocks = useMemo(() => {
    const generated = currentBlocks.filter((block) => block.status !== "PENDING");
    return generated.length ? generated : currentBlocks.slice(0, 1);
  }, [currentBlocks]);
  const currentTeachingMessages = useMemo(
    () => currentProblem ? project.problemTeachingMessages?.[currentProblem.id] || [] : [],
    [currentProblem, project.problemTeachingMessages],
  );
  const currentSideMessages = useMemo(
    () => currentProblem ? project.problemSideMessages?.[currentProblem.id] || [] : [],
    [currentProblem, project.problemSideMessages],
  );
  const currentKnowledgeCheckpoints = useMemo(
    () => currentProblem ? project.problemKnowledgeCheckpoints?.[currentProblem.id] || [] : [],
    [currentProblem, project.problemKnowledgeCheckpoints],
  );
  const currentStage = currentProblem ? project.problemTeachingStages?.[currentProblem.id] || "READING_PROBLEM" : "READING_PROBLEM";
  const currentProgress = currentProblem ? project.problemProgress?.[currentProblem.id] || 0 : 0;
  const nextProblem = currentProblem
    ? project.problems.find((problem) => problem.index > currentProblem.index && problem.status !== "MISSING_INFO")
    : undefined;
  const pendingKnowledgeCheckpoints = currentKnowledgeCheckpoints.filter((item) => item.status === "PENDING");
  const knowledgeSurveyReady = pendingKnowledgeCheckpoints.length > 0
    && pendingKnowledgeCheckpoints.every((item) => Boolean(knowledgeAnswers[item.id]));
  const currentProjectContext = currentProblem ? contextForProblem(project, currentProblem.id) : project;
  const courseNameById = useMemo(() => new Map(courses.map((course) => [course.id, course.name])), [courses]);
  const activeCourseName = project.courseId ? courseNameById.get(project.courseId) || "课程项目" : "";
  const selectedCourseForNewProject = newProjectCourseId ? courses.find((course) => course.id === newProjectCourseId) : undefined;
  const teacherMaterials = project.materials.filter((material) => material.category !== "ASSIGNMENT");
  const readyTeacherMaterials = teacherMaterials.filter((material) => material.status === "READY").length;
  const pendingTeacherMaterials = teacherMaterials.filter((material) => ["UPLOADING", "PARSING", "NEEDS_OCR"].includes(material.status)).length;

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch("/api/projects").then((response) => response.json() as Promise<{ projects?: ProjectState[] }>),
      fetch("/api/courses").then((response) => response.json() as Promise<{ courses?: CourseSpace[] }>).catch(() => ({ courses: [] })),
    ])
      .then(async ([data, courseData]) => {
        if (!active) return;
        setCourses(courseData.courses || []);
        const params = new URLSearchParams(window.location.search);
        const requestedCourseId = params.get("courseId") || "";
        if (params.get("newProject") === "1") {
          setNewProjectCourseId(requestedCourseId);
          setNewProjectName("新作业");
          setNewProjectOpen(true);
        }
        if (data.projects?.length) {
          const normalized = data.projects.map(normalizeProjectForRelease);
          setProjects(normalized);
          const requestedProject = normalized.find((item) => item.id === params.get("projectId")) || normalized[0];
          const requestedProblemId = params.get("problemId");
          setProject(requestedProblemId && requestedProject.problems.some((problem) => problem.id === requestedProblemId)
            ? { ...requestedProject, currentProblemId: requestedProblemId }
            : requestedProject);
        } else setProject(emptyProject);
        hydrated.current = true;
      })
      .catch(() => {
        hydrated.current = true;
        setProjects([]);
        setProject(emptyProject);
        setToast("项目数据暂时无法读取，请稍后刷新页面。");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const isBenignResizeObserverError = (reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason || "");
      return message.includes("ResizeObserver loop completed with undelivered notifications")
        || message.includes("ResizeObserver loop limit exceeded");
    };
    const onError = (event: ErrorEvent) => {
      if (!isBenignResizeObserverError(event.error || event.message)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      if (!isBenignResizeObserverError(event.reason)) return;
      event.preventDefault();
    };
    window.addEventListener("error", onError, true);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError, true);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  useEffect(() => () => {
    mainRequestRef.current?.controller.abort();
    sideRequestRef.current?.controller.abort();
    problemRequestRef.current?.controller.abort();
    knowledgeLinkRequestRef.current?.abort();
    pdfRequestRef.current?.controller.abort();
    assignmentUploadRequestRef.current?.controller.abort();
    if (problemSelectionTimerRef.current) window.clearTimeout(problemSelectionTimerRef.current);
  }, []);

  useEffect(() => {
    if (!hydrated.current || project.id === "empty") return;
    const timer = window.setTimeout(() => {
      const next = { ...project, updatedAt: now() };
      fetch(`/api/projects/${project.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      }).catch(() => undefined);
      setProjects((items) => {
        const found = items.some((item) => item.id === project.id);
        return found ? items.map((item) => (item.id === project.id ? next : item)) : [next, ...items];
      });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [project]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!pdfParsing || !pdfStartedAt || !pdfEstimateSeconds) return;
    const update = () => {
      const elapsed = (Date.now() - pdfStartedAt) / 1000;
      setPdfProgress(Math.min(92, Math.max(4, Math.round(4 + 88 * (elapsed / pdfEstimateSeconds)))));
      setPdfRemainingSeconds(Math.max(0, Math.ceil(pdfEstimateSeconds - elapsed)));
    };
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [pdfEstimateSeconds, pdfParsing, pdfStartedAt]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: "end" });
  }, [currentTeachingMessages, project.rollbackPreview, pendingKnowledgeCheckpoints.length, mainThinking]);

  useEffect(() => {
    sideMessageEndRef.current?.scrollIntoView({ block: "end" });
  }, [currentSideMessages, sideThinking]);

  useEffect(() => {
    if (!currentProblemId || project.id === "empty") return;
    const key = `${project.id}:${currentProblemId}`;
    const controller = new AbortController();
    knowledgeLinkRequestRef.current?.abort();
    knowledgeLinkRequestRef.current = controller;
    const loadLinks = async () => {
      await requestDelay(320, controller.signal);
      const response = await fetch(`/api/projects/${project.id}/problems/${currentProblemId}/knowledge-links`, { signal: controller.signal });
      if (!response.ok) return;
      const payload = await response.json() as { courseId?: string; links?: Array<{ nodeId: string; nodeTitle: string; relevance: number; evidence: string }> };
      if (controller.signal.aborted) return;
      setKnowledgeCourseId(payload.courseId || "");
      setKnowledgeLinks(payload.links || []);
      if (payload.links?.length || knowledgeLinkAttempts.current.has(key)) return;
      knowledgeLinkAttempts.current.add(key);
      setKnowledgeLinking(true);
      try {
        const linked = await fetch(`/api/projects/${project.id}/problems/${currentProblemId}/knowledge-links`, { method: "POST", signal: controller.signal });
        if (!linked.ok) return;
        const linkedPayload = await linked.json() as { courseId?: string; links?: Array<{ nodeId: string; nodeTitle: string; relevance: number; evidence: string }> };
        if (controller.signal.aborted) return;
        setKnowledgeCourseId(linkedPayload.courseId || payload.courseId || "");
        setKnowledgeLinks(linkedPayload.links || []);
      } finally {
        if (!controller.signal.aborted) setKnowledgeLinking(false);
      }
    };
    void loadLinks().catch((error) => {
      if (!isAbortError(error)) setKnowledgeLinking(false);
    });
    return () => controller.abort();
  }, [currentProblemId, project.courseId, project.id]);

  const handleComposerKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    submit: () => void,
  ) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  const updateFromAgent = (response: AgentResponse, targetProblem = currentProblem, replaceAnswer = false) => {
    if (!targetProblem) return;
    setProject((current) => {
      const assistant = response.assistantMessage
        ? makeMessage("assistant", response.assistantMessage, response.stage)
        : null;
      const existingMessages = replaceAnswer
        ? (current.problemTeachingMessages?.[targetProblem.id] || []).filter((item) => item.role === "user").slice(-1)
        : current.problemTeachingMessages?.[targetProblem.id] || [];
      const freshAssistant = assistant && !repeatsLastAssistant(assistant.content, existingMessages) ? assistant : null;
      const existingKnowledge = current.problemKnowledgeCheckpoints?.[targetProblem.id] || [];
      const incomingKnowledge = response.knowledgeCheckpoints
        ?? (response.knowledgeCheckpoint ? [response.knowledgeCheckpoint] : undefined);
      const nextKnowledge = incomingKnowledge === undefined
        ? existingKnowledge
        : incomingKnowledge.length
          ? [
              ...existingKnowledge.filter((item) => item.status === "ANSWERED"),
              ...incomingKnowledge.filter((item) => !existingKnowledge.some((old) => old.id === item.id && old.status === "ANSWERED")),
            ]
          : existingKnowledge.filter((item) => item.status === "ANSWERED");
      return {
        ...current,
        status: response.stage === "DONE" ? "ACTIVE" : current.status,
        teachingStage: response.stage || current.teachingStage,
        selectedMethod: response.selectedMethod || current.selectedMethod,
        progress: response.progress ?? current.progress,
        answerBlocks: replaceAnswer
          ? [...current.answerBlocks.filter((block) => block.problemId !== targetProblem.id), ...(response.answerBlocks || [])]
          : mergeBlocks(current.answerBlocks, response.answerBlocks, targetProblem.id),
        problemTeachingMessages: {
          ...current.problemTeachingMessages,
          [targetProblem.id]: [...existingMessages, ...(freshAssistant ? [freshAssistant] : [])],
        },
        problemKnowledgeCheckpoints: {
          ...current.problemKnowledgeCheckpoints,
          [targetProblem.id]: response.stage === "DONE"
            ? nextKnowledge.filter((item) => item.status === "ANSWERED")
            : nextKnowledge,
        },
        problemTeachingStages: { ...current.problemTeachingStages, [targetProblem.id]: response.stage || current.problemTeachingStages?.[targetProblem.id] || "READING_PROBLEM" },
        problemSelectedMethods: { ...current.problemSelectedMethods, [targetProblem.id]: response.selectedMethod || current.problemSelectedMethods?.[targetProblem.id] || "" },
        problemProgress: { ...current.problemProgress, [targetProblem.id]: response.progress ?? current.problemProgress?.[targetProblem.id] ?? 0 },
        problemSolutionBlueprints: response.solutionBlueprint
          ? { ...current.problemSolutionBlueprints, [targetProblem.id]: response.solutionBlueprint }
          : current.problemSolutionBlueprints,
        memories: response.memory ? [response.memory, ...current.memories] : current.memories,
        checkpoints: response.checkpoint ? [...current.checkpoints, response.checkpoint] : current.checkpoints,
        problems: current.problems.map((problem) =>
          problem.id === targetProblem.id
            ? { ...problem, status: response.stage === "DONE" ? "COMPLETED" : "TEACHING" }
            : problem,
        ),
      };
    });
  };

  const sendMain = async (messageOverride?: string, contextOverride?: ProjectState, interactionOverride?: AgentRequest["interaction"]) => {
    const message = (messageOverride ?? mainInput).trim();
    if (!message || !currentProblem || busy) return;
    const targetProblem = currentProblem;
    const forceFreshAnswer = interactionOverride?.kind === "DIRECT_ANSWER";
    if (forceFreshAnswer) {
      setProject((current) => ({
        ...current,
        answerBlocks: current.answerBlocks.filter((block) => block.problemId !== targetProblem.id),
        problemTeachingMessages: { ...current.problemTeachingMessages, [targetProblem.id]: [] },
        problemSolutionBlueprints: Object.fromEntries(Object.entries(current.problemSolutionBlueprints || {}).filter(([problemId]) => problemId !== targetProblem.id)),
      }));
    }
    const requestId = ++requestSequence.current;
    const controller = new AbortController();
    mainRequestRef.current?.controller.abort();
    mainRequestRef.current = { id: requestId, controller };
    setMainInput("");
    setProject((current) => ({
      ...current,
      problemTeachingMessages: {
        ...current.problemTeachingMessages,
        [targetProblem.id]: [
          ...(current.problemTeachingMessages?.[targetProblem.id] || []),
          makeMessage("user", message, current.problemTeachingStages?.[targetProblem.id] || current.teachingStage),
        ],
      },
    }));
    setBusy(true);
    setMainThinking(true);
    try {
      if (rollbackMode) {
        const response = await agentCall({ action: "analyze_rollback", problem: targetProblem, project: contextOverride || currentProjectContext, message, responseMode: project.responseMode || "deep" }, controller.signal);
        if (mainRequestRef.current?.id !== requestId) return;
        setProject((current) => ({
          ...current,
          rollbackPreview: response.rollbackPreview || null,
        }));
        setRollbackMode(false);
      } else {
        const requestProjectBase = contextOverride || currentProjectContext;
        const requestProject = forceFreshAnswer
          ? {
              ...requestProjectBase,
              answerBlocks: [],
              problemSolutionBlueprints: Object.fromEntries(Object.entries(requestProjectBase.problemSolutionBlueprints || {}).filter(([problemId]) => problemId !== targetProblem.id)),
            }
          : requestProjectBase;
        const response = await agentCall({
          action: "chat",
          problem: targetProblem,
          project: requestProject,
          message,
          responseMode: project.responseMode || "deep",
          interaction: interactionOverride || inferInteraction(message),
        }, controller.signal);
        if (mainRequestRef.current?.id !== requestId) return;
        if (repeatsLastAssistant(response.assistantMessage, currentTeachingMessages)) {
          setToast("本轮没有生成新的讲解，已保留当前进度；请继续或换一种提问。");
        }
        updateFromAgent(response, targetProblem, forceFreshAnswer);
        if (response.warning) setToast(response.warning);
      }
    } catch (error) {
      if (!isAbortError(error)) setToast(error instanceof Error ? error.message : "发送失败，请重试。");
    } finally {
      if (mainRequestRef.current?.id === requestId) {
        mainRequestRef.current = null;
        setMainThinking(false);
        setBusy(false);
      }
    }
  };

  const knowledgeAnswerLabels: Record<NonNullable<KnowledgeCheckpoint["answer"]>, string> = {
    KNOWN: "已了解",
    UNCERTAIN: "不太清楚",
    UNKNOWN: "完全不了解",
    OTHER: "其他",
    SKIPPED: "跳过",
  };

  const submitKnowledgeSurvey = async () => {
    if (!currentProblem || !knowledgeSurveyReady) return;
    const answers = pendingKnowledgeCheckpoints.map((item) => ({
      checkpointId: item.id,
      answer: knowledgeAnswers[item.id] || "UNKNOWN" as const,
      ...(knowledgeAnswers[item.id] === "OTHER" && knowledgeNote.trim() ? { note: knowledgeNote.trim() } : {}),
    }));
    const answered = currentKnowledgeCheckpoints.map((item) => {
      const response = answers.find((answer) => answer.checkpointId === item.id);
      return response ? { ...item, status: "ANSWERED" as const, answer: response.answer } : item;
    });
    const summary = answers.map((answer) => {
      const item = pendingKnowledgeCheckpoints.find((checkpoint) => checkpoint.id === answer.checkpointId);
      return `${item?.name || "知识点"}：${knowledgeAnswerLabels[answer.answer]}`;
    }).join("；");
    setProject((current) => ({
      ...current,
      problemKnowledgeCheckpoints: { ...current.problemKnowledgeCheckpoints, [currentProblem.id]: answered },
    }));
    await sendMain(
      `我的掌握情况：${summary}${knowledgeNote.trim() ? `。补充：${knowledgeNote.trim()}` : ""}`,
      { ...currentProjectContext, knowledgeCheckpoints: answered },
      { kind: "KNOWLEDGE_SURVEY", answers },
    );
  };

  const skipCurrentSection = async () => {
    if (pendingKnowledgeCheckpoints.length && currentProblem) {
      const answered = currentKnowledgeCheckpoints.map((item) => item.status === "PENDING"
        ? { ...item, status: "ANSWERED" as const, answer: "SKIPPED" as const }
        : item);
      const answers = pendingKnowledgeCheckpoints.map((item) => ({ checkpointId: item.id, answer: "SKIPPED" as const }));
      setProject((current) => ({
        ...current,
        problemKnowledgeCheckpoints: { ...current.problemKnowledgeCheckpoints, [currentProblem.id]: answered },
      }));
      await sendMain("跳过知识点摸底，直接开始讲解", { ...currentProjectContext, knowledgeCheckpoints: answered }, { kind: "KNOWLEDGE_SURVEY", answers });
      return;
    }
    await sendMain("跳过当前板块，继续", undefined, { kind: "SKIP_SECTION" });
  };

  const sendSide = async () => {
    const message = sideInput.trim();
    if (!message || !currentProblem || busy) return;
    const targetProblem = currentProblem;
    const requestId = ++requestSequence.current;
    const controller = new AbortController();
    sideRequestRef.current?.controller.abort();
    sideRequestRef.current = { id: requestId, controller };
    setSideInput("");
    setProject((current) => ({
      ...current,
      problemSideMessages: {
        ...current.problemSideMessages,
        [targetProblem.id]: [
          ...(current.problemSideMessages?.[targetProblem.id] || []),
          makeMessage("user", message),
        ],
      },
    }));
    setBusy(true);
    setSideThinking(true);
    try {
      const response = await agentCall({ action: "side_chat", problem: targetProblem, project: contextForProblem(projectRef.current, targetProblem.id), message, responseMode: project.responseMode || "deep" }, controller.signal);
      if (sideRequestRef.current?.id !== requestId) return;
      setProject((current) => ({
        ...current,
        problemSideMessages: {
          ...current.problemSideMessages,
          [targetProblem.id]: [
            ...(current.problemSideMessages?.[targetProblem.id] || []),
            makeMessage("assistant", response.sideAnswer || "我暂时无法回答这个问题。"),
          ],
        },
        memories: response.memory ? [response.memory, ...current.memories] : current.memories,
      }));
    } catch (error) {
      if (!isAbortError(error)) setToast(error instanceof Error ? error.message : "千问暂时不可用。");
    } finally {
      if (sideRequestRef.current?.id === requestId) {
        sideRequestRef.current = null;
        setSideThinking(false);
        setBusy(false);
      }
    }
  };

  const startProblem = async (problem: Problem) => {
    if (problem.status === "MISSING_INFO") {
      setToast("这道题存在硬缺失，请先补充材料。");
      return;
    }
    const requestId = ++requestSequence.current;
    const controller = new AbortController();
    problemRequestRef.current?.controller.abort();
    problemRequestRef.current = { id: requestId, problemId: problem.id, controller };
    setBusy(true);
    setMainThinking(true);
    setKnowledgeAnswers({});
    setKnowledgeNote("");
    setKnowledgeLinks([]);
    setKnowledgeCourseId(projectRef.current.courseId || "");
    setKnowledgeLinking(false);
    setProject((current) => ({
      ...current,
      currentProblemId: problem.id,
      status: "ACTIVE",
      problems: current.problems.map((item) => (item.id === problem.id ? { ...item, status: "PREPARING" } : item)),
    }));
    try {
      const latestProject = projectRef.current;
      const response = await agentCall({ action: "start_problem", problem, project: contextForProblem(latestProject, problem.id), responseMode: latestProject.responseMode || "deep" }, controller.signal);
      if (problemRequestRef.current?.id !== requestId) return;
      updateFromAgent(response, problem);
    } catch (error) {
      if (!isAbortError(error)) {
        setProject((current) => ({
          ...current,
          problems: current.problems.map((item) => item.id === problem.id && item.status === "PREPARING"
            ? { ...item, status: "NOT_STARTED" }
            : item),
        }));
        setToast(error instanceof Error ? error.message : "题目准备失败，请重试。");
      }
    } finally {
      if (problemRequestRef.current?.id === requestId) {
        problemRequestRef.current = null;
        setMainThinking(false);
        setBusy(false);
      }
    }
  };

  const cancelInteractiveRequests = (resetPreparingProblem = true) => {
    if (problemSelectionTimerRef.current) {
      window.clearTimeout(problemSelectionTimerRef.current);
      problemSelectionTimerRef.current = null;
    }
    const preparingProblemId = problemRequestRef.current?.problemId;
    problemRequestRef.current?.controller.abort();
    mainRequestRef.current?.controller.abort();
    sideRequestRef.current?.controller.abort();
    problemRequestRef.current = null;
    mainRequestRef.current = null;
    sideRequestRef.current = null;
    setBusy(false);
    setMainThinking(false);
    setSideThinking(false);
    if (resetPreparingProblem && preparingProblemId) {
      setProject((current) => ({
        ...current,
        problems: current.problems.map((item) => item.id === preparingProblemId && item.status === "PREPARING"
          ? { ...item, status: "NOT_STARTED" }
          : item),
      }));
    }
  };

  const selectProblem = (problem: Problem) => {
    const alreadyPreparing = problemRequestRef.current?.problemId === problem.id;
    if (alreadyPreparing && projectRef.current.currentProblemId === problem.id) return;
    cancelInteractiveRequests(true);
    setProject((current) => {
      const next = {
        ...current,
        currentProblemId: problem.id,
        teachingStage: current.problemTeachingStages?.[problem.id] || "READING_PROBLEM" as const,
        selectedMethod: current.problemSelectedMethods?.[problem.id] || "",
        progress: current.problemProgress?.[problem.id] || 0,
        rollbackPreview: null,
      };
      projectRef.current = next;
      return next;
    });
    setMainInput("");
    setSideInput("");
    setKnowledgeAnswers({});
    setKnowledgeNote("");
    setKnowledgeLinks([]);
    setKnowledgeCourseId(projectRef.current.courseId || "");
    setKnowledgeLinking(false);
    if (["NOT_STARTED", "PREPARING"].includes(problem.status) && projectRef.current.status !== "AWAITING_CONFIRMATION") {
      problemSelectionTimerRef.current = window.setTimeout(() => {
        problemSelectionTimerRef.current = null;
        void startProblem(problem);
      }, 260);
    }
  };

  const selectProject = (next: ProjectState) => {
    cancelInteractiveRequests(false);
    assignmentUploadRequestRef.current?.controller.abort();
    assignmentUploadRequestRef.current = null;
    setAssignmentUpload(null);
    projectRef.current = next;
    setProject(next);
    setMainInput("");
    setSideInput("");
    setKnowledgeAnswers({});
    setKnowledgeNote("");
    setKnowledgeLinks([]);
    setKnowledgeCourseId(next.courseId || "");
    setKnowledgeLinking(false);
  };

  const resetNewProjectDraft = (courseId = "") => {
    pdfRequestRef.current?.controller.abort();
    pdfRequestRef.current = null;
    setNewProjectCourseId(courseId);
    setNewProjectName("新作业");
    setAssignmentText("");
    setNewProjectFile(null);
    setReferenceFiles([]);
    setNewProjectPdfText("");
    setNewProjectProblems([]);
    setPdfSummary("");
    setPdfParsing(false);
    setPdfProgress(0);
    setPdfEstimateSeconds(0);
    setPdfStartedAt(0);
    setPdfRemainingSeconds(0);
  };

  const openNewProject = (courseId = "") => {
    resetNewProjectDraft(courseId);
    setNewProjectOpen(true);
  };

  const closeNewProject = () => {
    pdfRequestRef.current?.controller.abort();
    pdfRequestRef.current = null;
    setPdfParsing(false);
    setNewProjectOpen(false);
  };

  const persistMaterialFile = async (projectId: string, material: Material, file: File, signal?: AbortSignal) => {
    if (file.size > 2_500_000) {
      const initializedResponse = await fetchWithRetry("/api/materials/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, materialId: material.id, name: file.name, size: file.size, mimeType: file.type, category: material.category }),
        signal,
      }, 3);
      const initialized = await initializedResponse.json() as { objectKey?: string; uploadId?: string; partSize?: number; error?: string };
      if (!initializedResponse.ok || !initialized.uploadId || !initialized.partSize) throw new Error(initialized.error || "无法建立分片上传任务");
      const parts: Array<{ partNumber: number; etag: string }> = [];
      const total = Math.ceil(file.size / initialized.partSize);
      for (let index = 0; index < total; index += 1) {
        const body = file.slice(index * initialized.partSize, Math.min(file.size, (index + 1) * initialized.partSize));
        const partResponse = await fetchWithRetry(`/api/materials/${material.id}/uploads/${encodeURIComponent(initialized.uploadId)}/parts/${index + 1}`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body,
          signal,
        }, 4);
        const part = await partResponse.json() as { partNumber?: number; etag?: string; error?: string };
        if (!partResponse.ok || !part.partNumber || !part.etag) throw new Error(part.error || `第 ${index + 1} 个分片上传失败`);
        parts.push({ partNumber: part.partNumber, etag: part.etag });
      }
      const completeResponse = await fetchWithRetry(`/api/materials/${material.id}/uploads/${encodeURIComponent(initialized.uploadId)}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts }),
        signal,
      }, 3);
      const completed = await completeResponse.json() as { objectKey?: string; error?: string };
      if (!completeResponse.ok) throw new Error(completed.error || "资料分片合并失败");
      return { objectKey: completed.objectKey || initialized.objectKey };
    }
    const form = new FormData();
    form.append("file", file);
    form.append("projectId", projectId);
    form.append("materialId", material.id);
    form.append("category", material.category);
    const response = await fetchWithRetry("/api/materials", { method: "POST", body: form, signal }, 3);
    const result = (await response.json()) as { objectKey?: string; error?: string };
    if (!response.ok) throw new Error(result.error || "文件保存失败");
    return { objectKey: result.objectKey };
  };

  const patchProjectMaterial = async (projectId: string, materialId: string, patch: Partial<Material>) => {
    let base = projectRef.current.id === projectId ? projectRef.current : projects.find((item) => item.id === projectId);
    if (!base) {
      const response = await fetch(`/api/projects/${projectId}`);
      if (!response.ok) throw new Error("作业状态已变化，无法更新资料状态。");
      base = ((await response.json()) as { project: ProjectState }).project;
    }
    const next = {
      ...base,
      materials: base.materials.map((item) => item.id === materialId ? { ...item, ...patch } : item),
      updatedAt: now(),
    };
    if (projectRef.current.id === projectId) {
      projectRef.current = next;
      setProject(next);
    }
    setProjects((items) => items.map((item) => item.id === projectId ? next : item));
    const saved = await fetch(`/api/projects/${projectId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    if (!saved.ok) throw new Error("资料已处理，但状态保存失败。");
    return next;
  };

  const parseStoredReference = async (projectId: string, materialId: string, signal?: AbortSignal) => {
    const response = await fetchWithRetry("/api/materials/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, materialId }),
      signal,
    }, 2);
    const result = (await response.json()) as {
      extractedText?: string;
      learningDigest?: string;
      characterCount?: number;
      understandingMode?: Material["understandingMode"];
      visualReady?: boolean;
      error?: string;
    };
    if (!response.ok || !result.extractedText) throw new Error(result.error || "老师资料解析失败");
    return result;
  };

  const processReferenceMaterial = async (projectId: string, material: Material, file?: File) => {
    const jobKey = `${projectId}:${material.id}`;
    if (referenceParseJobsRef.current.has(jobKey)) return;
    referenceParseJobsRef.current.add(jobKey);
    try {
      const isVisualFile = Boolean(file && (file.type === "application/pdf" || file.type.startsWith("image/") || /\.(pdf|png|jpe?g|webp|bmp)$/i.test(file.name)));
      const visualParsed = isVisualFile && file
        ? await extractVisualDocumentText(file).then((extractedText) => ({
            extractedText,
            learningDigest: buildReferenceDigest(extractedText),
            understandingMode: "VISUAL_DOCUMENT" as const,
            visualReady: true,
          }))
        : undefined;
      let objectKey = material.objectKey;
      if (!objectKey) {
        if (!file) throw new Error("缺少资料原件，请重新上传。");
        await patchProjectMaterial(projectId, material.id, { status: "UPLOADING", parseProgress: 10, parseError: undefined });
        try {
          const saved = await persistMaterialFile(projectId, material, file);
          objectKey = saved.objectKey;
        } catch (error) {
          // A temporary R2/network failure must not discard a reference that
          // the browser and Qwen have already read successfully. The extracted
          // text remains persisted in ProjectState and is immediately usable.
          if (!visualParsed) throw error;
          setToast(`${material.name} 已完成视觉学习；原文件云端保存失败，可稍后重新上传。`);
        }
      }
      await patchProjectMaterial(projectId, material.id, { objectKey, status: "PARSING", parseProgress: 35, parseError: undefined });
      const parsed = visualParsed || await parseStoredReference(projectId, material.id);
      await patchProjectMaterial(projectId, material.id, {
        objectKey,
        status: "READY",
        parseProgress: 100,
        extractedText: parsed.extractedText,
        learningDigest: parsed.learningDigest,
        understandingMode: parsed.understandingMode,
        visualReady: parsed.visualReady,
        parseError: undefined,
      });
      // Do not solve every question in the background. The selected question
      // is solved and independently reviewed on demand, so rapid navigation
      // cannot start a queue of expensive, stale model jobs.
      setToast(parsed.visualReady
        ? `已完成视觉学习：${material.name}（原始页面、公式与文字索引均已就绪）`
        : `已建立老师资料索引：${material.name}`);
    } catch (error) {
      await patchProjectMaterial(projectId, material.id, {
        status: "ERROR",
        parseProgress: 0,
        parseError: error instanceof Error ? error.message : "资料解析失败",
      }).catch(() => undefined);
      setToast(error instanceof Error ? `${material.name}：${error.message}` : `${material.name} 解析失败`);
    } finally {
      referenceParseJobsRef.current.delete(jobKey);
    }
  };

  const addCurrentReferenceMaterials = async (files: FileList | null) => {
    const current = projectRef.current;
    if (current.id === "empty" || !files?.length) return;
    const entries = Array.from(files).map((file) => ({
      file,
      material: {
        id: uid("material"),
        name: file.name,
        category: "COURSE_RULE" as const,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        status: "UPLOADING" as const,
        parseProgress: 0,
      },
    }));
    const next = { ...current, materials: [...current.materials, ...entries.map((entry) => entry.material)], updatedAt: now() };
    projectRef.current = next;
    setProject(next);
    setProjects((items) => items.map((item) => item.id === next.id ? next : item));
    const saved = await fetchWithRetry(`/api/projects/${next.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    }, 3);
    if (!saved.ok) {
      setToast("参考资料记录保存失败，请重试。");
      return;
    }
    setToast(`已加入 ${entries.length} 份参考资料，正在后台学习。`);
    entries.forEach((entry) => { void processReferenceMaterial(next.id, entry.material, entry.file); });
  };

  useEffect(() => {
    if (project.id === "empty") return;
    project.materials
      .filter((material) => material.category !== "ASSIGNMENT" && material.status === "PARSING" && material.objectKey && !material.extractedText)
      .forEach((material) => { void processReferenceMaterial(project.id, material); });
    // Parsing resumes from persisted state and is de-duplicated by
    // referenceParseJobsRef; only project/material changes should recheck it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, project.materials]);

  const prepareProjectPdf = async (file: File) => {
    if ((!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") || file.size > 20 * 1024 * 1024) {
      setPdfSummary(file.size > 20 * 1024 * 1024 ? "PDF 不能超过 20MB。" : "请选择 PDF 文件。");
      return;
    }
    const fingerprint = `${file.name}:${file.size}:${file.lastModified}`;
    if (pdfRequestRef.current?.fingerprint === fingerprint || (newProjectFile && `${newProjectFile.name}:${newProjectFile.size}:${newProjectFile.lastModified}` === fingerprint && newProjectProblems.length)) return;
    pdfRequestRef.current?.controller.abort();
    const requestId = ++requestSequence.current;
    const controller = new AbortController();
    pdfRequestRef.current = { id: requestId, fingerprint, controller };
    const estimate = estimatePdfSeconds(file);
    setNewProjectFile(file);
    setNewProjectPdfText("");
    setNewProjectProblems([]);
    setPdfSummary(`千问正在识别 PDF，预计${formatEstimate(estimate)}…`);
    setPdfEstimateSeconds(estimate);
    setPdfRemainingSeconds(estimate);
    setPdfStartedAt(Date.now());
    setPdfProgress(4);
    setPdfParsing(true);
    try {
      const extractedText = await extractVisualDocumentText(file, controller.signal, (completed, total, phase) => {
        if (pdfRequestRef.current?.id !== requestId) return;
        setPdfProgress(phase === "recognize"
          ? Math.min(88, 44 + Math.round((completed / total) * 44))
          : Math.min(44, 4 + Math.round((completed / total) * 40)));
        setPdfSummary(phase === "recognize"
          ? `千问正在阅读 PDF 页面 ${completed}/${total}…`
          : `正在准备 PDF 视觉页面 ${completed}/${total}…`);
      });
      const parsed = await agentCall({ action: "parse_assignment", assignmentText: extractedText }, controller.signal);
      if (pdfRequestRef.current?.id !== requestId) return;
      setNewProjectPdfText(extractedText);
      setNewProjectProblems(normalizeProblems(parsed.problems));
      setPdfProgress(100);
      setPdfRemainingSeconds(0);
      setPdfSummary(`千问已识别并整理 ${parsed.problems?.length || 0} 道题`);
      if (["微积分作业", "新作业"].includes(newProjectName)) {
        setNewProjectName(file.name.replace(/\.pdf$/i, ""));
      }
    } catch (error) {
      if (isAbortError(error)) return;
      setNewProjectPdfText("");
      setNewProjectProblems([]);
      setPdfProgress(0);
      setPdfRemainingSeconds(0);
      setPdfSummary(error instanceof Error ? error.message : "PDF 识别失败，请重试");
    } finally {
      if (pdfRequestRef.current?.id === requestId) {
        pdfRequestRef.current = null;
        setPdfParsing(false);
      }
    }
  };

  const createProject = async () => {
    if (!newProjectName.trim()) {
      setToast("请填写作业名称。");
      return;
    }
    if (!newProjectFile) {
      setToast("请选择作业 PDF。");
      return;
    }
    const importFile = newProjectFile;
    const preparedProblems = newProjectProblems;
    const preparedPdfText = newProjectPdfText;
    const shouldContinueImportInBackground = Boolean(importFile && !preparedProblems.length);
    if (shouldContinueImportInBackground) {
      pdfRequestRef.current?.controller.abort();
      pdfRequestRef.current = null;
      setPdfParsing(false);
    }
    setBusy(true);
    try {
      const referenceEntries = referenceFiles.map((file) => ({
        material: {
          id: uid("material"),
          name: file.name,
          category: "COURSE_RULE" as const,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          status: "UPLOADING" as const,
          parseProgress: 0,
        },
        file,
      }));
      let next: ProjectState = {
        ...createProjectState(newProjectName.trim(), preparedProblems),
        courseId: newProjectCourseId || null,
        materials: referenceEntries.map((entry) => entry.material),
      };
      if (importFile && preparedProblems.length) {
        next = { ...next, materials: [{
          id: uid("material"),
          name: importFile.name,
          category: "ASSIGNMENT",
          mimeType: importFile.type || "application/pdf",
          size: importFile.size,
          status: "READY",
          extractedText: preparedPdfText,
        }, ...next.materials] };
      }
      if (assignmentText.trim()) {
        next = { ...next, materials: [...next.materials, {
          id: uid("material"),
          name: "补充说明",
          category: "REFERENCE",
          mimeType: "text/plain",
          size: new Blob([assignmentText.trim()]).size,
          status: "READY",
          extractedText: assignmentText.trim(),
        }] };
      }
      const created = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!created.ok) {
        const payload = await created.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || `作业创建失败（${created.status}）`);
      }
      if (importFile && preparedProblems.length && next.materials[0]) {
        try {
          const saved = await persistMaterialFile(next.id, next.materials[0], importFile);
          next = { ...next, materials: next.materials.map((material, index) => index === 0 ? { ...material, objectKey: saved.objectKey } : material) };
        } catch {
          setToast("题目已读取，但 PDF 原件保存失败；可以继续使用当前项目。");
        }
      }
      await fetch(`/api/projects/${next.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      setProjects((items) => [next, ...items]);
      projectRef.current = next;
      setProject({ ...next });
      setProjects((items) => items.map((item) => item.id === next.id ? { ...next } : item));
      setNewProjectOpen(false);
      resetNewProjectDraft();
      referenceEntries.forEach((entry) => { void processReferenceMaterial(next.id, entry.material, entry.file); });
      setToast(shouldContinueImportInBackground
        ? "已创建作业，PDF 正在后台上传并整理；你可以继续使用页面。"
        : next.problems.length
        ? `已整理 ${next.problems.length} 道题${referenceFiles.length ? `；${referenceFiles.length} 份老师资料正在后台学习` : ""}，请确认后开始。`
        : "已创建作业，PDF 将继续在后台整理。");
      if (shouldContinueImportInBackground && importFile) void uploadMaterial(importFile);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "项目创建失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const confirmProblems = async () => {
    const firstReady = project.problems.find((problem) => problem.status !== "MISSING_INFO");
    setProject((current) => ({ ...current, status: "READY", currentProblemId: firstReady?.id || null }));
    if (firstReady) await startProblem(firstReady);
  };

  const uploadMaterial = async (file: File) => {
    const targetProjectId = projectRef.current.id;
    if (targetProjectId === "empty") {
      openNewProject();
      return;
    }
    assignmentUploadRequestRef.current?.controller.abort();
    const requestId = ++requestSequence.current;
    const controller = new AbortController();
    assignmentUploadRequestRef.current = { id: requestId, projectId: targetProjectId, controller };
    setAssignmentUpload({ projectId: targetProjectId, fileName: file.name, startedAt: Date.now() });
    const materialId = uid("material");
    let extractedText = "";
    let parsedProblems: Problem[] = [];
    try {
      const visualText = await extractVisualDocumentText(file, controller.signal);
      const parsed = await agentCall({ action: "parse_assignment", assignmentText: visualText }, controller.signal);
      if (assignmentUploadRequestRef.current?.id !== requestId || projectRef.current.id !== targetProjectId) return;
      extractedText = visualText;
      parsedProblems = normalizeProblems(parsed.problems);
    } catch (error) {
      if (!isAbortError(error)) setToast(error instanceof Error ? error.message : "PDF 识别失败，请重试。");
      if (assignmentUploadRequestRef.current?.id === requestId) {
        assignmentUploadRequestRef.current = null;
        setAssignmentUpload(null);
      }
      return;
    }

    const material: Material = {
      id: materialId,
      name: file.name,
      category: "ASSIGNMENT",
      mimeType: file.type,
      size: file.size,
      status: "READY",
      extractedText,
    };
    setProject((current) => ({ ...current, materials: [...current.materials, material] }));

    try {
      const saved = await persistMaterialFile(targetProjectId, material, file, controller.signal);
      setProject((current) => ({
        ...current,
        materials: current.materials.map((item) =>
          item.id === materialId ? { ...item, objectKey: saved.objectKey } : item,
        ),
      }));
      setToast(`千问已识别 ${file.name}`);
    } catch (error) {
      if (!isAbortError(error)) setToast("文件内容已在当前页面读取，但云端原件保存失败。");
    }

    if (controller.signal.aborted || assignmentUploadRequestRef.current?.id !== requestId || projectRef.current.id !== targetProjectId) return;
    if (parsedProblems.length) {
      setProject((current) => ({
        ...current,
        status: "AWAITING_CONFIRMATION",
        problems: parsedProblems.map((problem, index) => ({ ...problem, index: index + 1 })),
        answerBlocks: [],
        teachingMessages: [],
        knowledgeCheckpoints: [],
        problemTeachingMessages: {},
        problemSideMessages: {},
        problemKnowledgeCheckpoints: {},
        problemTeachingStages: {},
        problemSelectedMethods: {},
        problemProgress: {},
        problemSolutionBlueprints: {},
        checkpoints: [],
        currentProblemId: parsedProblems[0]?.id || null,
      }));
    }
    if (assignmentUploadRequestRef.current?.id === requestId) {
      assignmentUploadRequestRef.current = null;
      setAssignmentUpload(null);
    }
  };

  const confirmRollback = () => {
    const preview = project.rollbackPreview;
    if (!preview || !currentProblem) return;
    setProject((current) => ({
      ...current,
      answerVersion: current.answerVersion + 1,
      selectedMethod: preview.newMethod,
      teachingStage: preview.resumeStage,
      progress: Math.min(current.progress, 35),
      answerBlocks: current.answerBlocks.map((block) =>
        preview.invalidatedBlockIds.includes(block.id)
          ? { ...block, status: "ROLLED_BACK", version: current.answerVersion }
          : block,
      ),
      problemTeachingMessages: {
        ...current.problemTeachingMessages,
        [currentProblem.id]: [
          ...(current.problemTeachingMessages?.[currentProblem.id] || []).map((message) => ({ ...message, archivedVersion: current.answerVersion })),
          makeMessage(
            "assistant",
            `已回退到“${preview.title}”。保留审题与已知条件，撤回受旧方法影响的推导；接下来改用${preview.newMethod}。`,
            preview.resumeStage,
          ),
        ],
      },
      problemTeachingStages: { ...current.problemTeachingStages, [currentProblem.id]: preview.resumeStage },
      problemSelectedMethods: { ...current.problemSelectedMethods, [currentProblem.id]: preview.newMethod },
      problemProgress: { ...current.problemProgress, [currentProblem.id]: Math.min(current.problemProgress?.[currentProblem.id] || 0, 35) },
      memories: [
        {
          id: uid("memory"),
          type: "PREFERENCE",
          title: "解法偏好已更新",
          value: `后续优先考虑${preview.newMethod}`,
          confidence: 0.9,
          evidence: [preview.reason],
          updatedAt: now(),
        },
        ...current.memories,
      ],
      rollbackPreview: null,
    }));
    setToast("回退完成，旧答案仍可在历史版本中查看。");
  };

  const exportLatex = () => {
    const content = currentBlocks
      .filter((block) => !["PENDING", "ROLLED_BACK", "INVALIDATED"].includes(block.status))
      .map((block) => `% ${block.title}\n${block.latex}\n`)
      .join("\n");
    const blob = new Blob([content || "% 当前还没有可导出的答案块。"], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${currentProblem?.title || "answer"}-v${project.answerVersion}.tex`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className={`agent-shell ${sidebarOpen ? "" : "sidebar-collapsed"} ${sideAssistantOpen ? "" : "assistant-closed"}`}>
      <aside className="project-sidebar" aria-label="项目导航">
        <div className="brand-row">
          <div className="brand-mark"><BrainCircuit size={20} /></div>
          {sidebarOpen && <div><strong>LearnFlow</strong><span>作业辅导台</span></div>}
          <button className="icon-button sidebar-toggle" onClick={() => setSidebarOpen((open) => !open)} aria-label="收起或展开侧边栏">
            {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
        </div>
        <button className="new-project-button" onClick={() => openNewProject()}>
          <Plus size={17} /> {sidebarOpen && "新建作业"}
        </button>
        <a className="new-course-project-button" href="/learn?newCourse=1" aria-label="新建课程项目">
          <Network size={16} /> {sidebarOpen && "新建课程项目"}
        </a>
        <a className="v2-course-entry" href="/learn" aria-label="打开课程知识学习与复习图谱">
          <BrainCircuit size={17} /> {sidebarOpen && <span><strong>进入课程空间</strong><small>管理课件、图谱与项目内作业</small></span>}
        </a>
        {sidebarOpen && (
          <>
            <div className="sidebar-label">作业列表</div>
            <div className="project-groups" aria-label="作业列表">
              <section className="project-group assignment-only-list">
                {projects.map((item) => {
                  const courseName = item.courseId ? courseNameById.get(item.courseId) : "";
                  return (
                    <button key={item.id} className={item.id === project.id ? "active" : ""} onClick={() => selectProject(item)}>
                      <span className="entity-kind assignment-kind">作业</span>
                      <span className="assignment-row-copy"><strong>{item.name}</strong><small>{courseName ? `课程项目 · ${courseName}` : "独立作业"}</small></span>
                      <small>{item.problems.length} 题</small>
                    </button>
                  );
                })}
              </section>
              {!projects.length && <div className="empty-project-select">还没有作业，点击上方“新建作业”开始。</div>}
            </div>
            {project.id !== "empty" && <nav className="sidebar-nav">
              {assignmentUpload?.projectId === project.id ? (
                <div className="assignment-upload-state" role="status">
                  <span><LoaderCircle size={16} className="spin" /><strong>正在整理 PDF</strong><small>{assignmentUpload.fileName}</small></span>
                  <button aria-label="取消当前 PDF 识别" onClick={() => {
                    assignmentUploadRequestRef.current?.controller.abort();
                    assignmentUploadRequestRef.current = null;
                    setAssignmentUpload(null);
                    setToast("已取消这份 PDF 的上传与识别。");
                  }}><X size={15} /></button>
                </div>
              ) : (
                <button className="sidebar-upload" onClick={() => currentReferenceInput.current?.click()}><Upload size={17} />为当前作业添加参考资料</button>
              )}
              <input
                ref={currentReferenceInput}
                className="sr-only"
                type="file"
                multiple
                accept=".pdf,.png,.jpg,.jpeg,.webp,.bmp,.txt,.md,.markdown,.doc,.docx,.ppt,.pptx"
                onChange={(event) => {
                  void addCurrentReferenceMaterials(event.target.files);
                  event.target.value = "";
                }}
              />
              <input
                ref={fileInput}
                className="sr-only"
                type="file"
                accept=".pdf"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadMaterial(file);
                  event.target.value = "";
                }}
              />
            </nav>}
            <div className="sidebar-label problems-label">题目列表</div>
            <div className="problem-list">
              {project.problems.map((problem) => (
                <button
                  key={problem.id}
                  data-testid={`problem-${problem.index}`}
                  className={problem.id === currentProblem?.id ? "active" : ""}
                  onClick={() => selectProblem(problem)}
                >
                  <span className="problem-index">{problem.index}</span>
                  <span className="problem-copy"><strong>第{problem.index}题</strong><small>{problem.title}</small></span>
                  <span className={`problem-state state-${problem.status.toLowerCase()}`}>{statusLabels[problem.status]}</span>
                </button>
              ))}
            </div>
            <div className="sidebar-bottom"><span>{project.id === "empty"
              ? "普通作业独立存在；课程项目作业继承项目资料"
              : pendingTeacherMaterials
                ? `老师资料视觉学习中 ${readyTeacherMaterials}/${teacherMaterials.length}`
                : teacherMaterials.length
                  ? `老师资料已就绪 ${readyTeacherMaterials}/${teacherMaterials.length}`
              : project.materials.length
                ? `已导入 ${project.materials.length} 份资料`
                : project.problems.length
                  ? `已整理 ${project.problems.length} 道题`
                  : "尚未识别题目"}</span></div>
          </>
        )}
      </aside>

      <section className="app-main">
        <header className="top-status-bar">
          <div className="top-title">
            <button className="icon-button mobile-menu" onClick={() => setSidebarOpen((open) => !open)}><Menu size={18} /></button>
            <div>
              <span className="eyebrow">{project.courseId ? `课程项目作业 · ${activeCourseName}` : "独立作业"} · {project.name}</span>
              <strong>{currentProblem ? `第${currentProblem.index}题 · ${currentProblem.title}` : "尚未选择题目"}</strong>
            </div>
          </div>
          <div className="top-actions">
            <div className="response-mode" role="group" aria-label="回答模式">
              <button className={project.responseMode === "fast" ? "active" : ""} onClick={() => setProject((current) => ({ ...current, responseMode: "fast" }))} disabled={busy} title="使用更快的模型，适合常规题"><Zap size={14} /><span>快速</span></button>
              <button className={project.responseMode !== "fast" ? "active" : ""} onClick={() => setProject((current) => ({ ...current, responseMode: "deep" }))} disabled={busy} title="使用当前高质量模型，适合复杂推导"><BrainCircuit size={14} /><span>思考</span></button>
            </div>
            <div className="progress-chip"><b style={{ width: `${currentProgress}%` }} />{currentProgress}%</div>
            <button className="secondary-button" onClick={exportLatex}><Download size={16} />导出答案</button>
            <button className="icon-button" onClick={() => setSideAssistantOpen((open) => !open)} aria-label="显示或隐藏知识助手">
              <MessageCircleQuestion size={18} />
            </button>
          </div>
        </header>

        {project.status === "AWAITING_CONFIRMATION" && (
          <div className="confirmation-bar">
            <FileSearch size={18} />
            <span>已拆分 {project.problems.length} 道题；请确认题目数量、文字、公式与缺失信息。</span>
            <button onClick={() => void confirmProblems()} disabled={busy}><Check size={16} />确认题目列表并开始</button>
          </div>
        )}

        <div className="workspace-grid">
          <section className="pane answer-pane" aria-label="标准答案">
            <div className="pane-header answer-header">
              <div><h1>{currentProblem?.title || "请导入作业 PDF"}</h1><span className="pane-kicker">{currentProblem ? `第${currentProblem.index}题` : "等待导入"}</span></div>
            </div>
            <div className="problem-card">
              <MarkdownMath content={currentProblem?.rawText || "导入 PDF 后，这里会显示识别出的题目。"} className="problem-rich-text" />
              {!!currentProblem?.missingInformation?.length && (
                <div className="missing-banner">
                  <CircleHelp size={17} />
                  <div><strong>需要补充信息</strong>{currentProblem.missingInformation.map((item) => <span key={item.description}>{item.description} {item.suggestion}</span>)}</div>
                </div>
              )}
            </div>
            <div className="answer-title-row">
              <div><strong>答案</strong></div>
              <span>v{project.answerVersion}</span>
            </div>
            <div className="answer-blocks">
              {visibleBlocks.length ? visibleBlocks.map((block) => (
                <article key={block.id} className={`answer-block block-${block.status.toLowerCase()}`} data-testid={`answer-block-${block.order}`}>
                  <div className="answer-block-heading">
                    <span className="block-number">{block.order}</span>
                    <strong>{block.title}</strong>
                    {["COMMITTED", "VERIFIED", "SKIPPED_TEACHING"].includes(block.status) && <CheckCircle2 className="block-check" size={16} />}
                  </div>
                  <MarkdownMath content={block.plainText} className="answer-rich-text" />
                </article>
              )) : (
                <div className={`empty-state ${currentProblem ? "" : "empty-assignment-state"}`}>
                  <FileSearch size={26} />
                  <strong>{currentProblem ? "答案会随讲解逐步生成" : project.id === "empty" ? "先新建并导入一份作业" : "暂未识别出题目"}</strong>
                  {!currentProblem && <span>{project.id === "empty" ? "请从左侧新建作业并选择作业 PDF。" : "可以重新上传 PDF，已有参考资料仍会保留。"}</span>}
                  {!currentProblem && project.id !== "empty" && <button onClick={() => fileInput.current?.click()}><Upload size={15} />上传作业 PDF</button>}
                </div>
              )}
              {currentProblem && (knowledgeCourseId || knowledgeLinks.length > 0 || knowledgeLinking) && (
                <div className="problem-knowledge-links">
                  <div><Network size={16} /><strong>本题知识路径</strong>{knowledgeLinking && <span>正在匹配课程图谱…</span>}</div>
                  <div>
                    {knowledgeLinks.slice(0, 5).map((link) => (
                      <a key={link.nodeId} href={`/learn?courseId=${knowledgeCourseId}&view=study&nodeId=${link.nodeId}`} title={mathTextToPlainLabel(link.evidence)}>
                        {link.nodeTitle}<ChevronRight size={13} />
                      </a>
                    ))}
                    {!knowledgeLinks.length && !knowledgeLinking && knowledgeCourseId && <a href={`/learn?courseId=${knowledgeCourseId}&view=graph`}>打开课程图谱<ChevronRight size={13} /></a>}
                  </div>
                </div>
              )}
            </div>
            <footer className="answer-footer">
              <span>版本 v{project.answerVersion}</span>
              <button><History size={15} />历史版本</button>
            </footer>
          </section>

          <section className="pane teaching-pane" aria-label="讲解与思路">
            <div className="teaching-tabs">
              <strong>讲解</strong>
              <div className="teaching-actions">
                <button onClick={() => void skipCurrentSection()} disabled={busy}><ChevronRight size={14} />{pendingKnowledgeCheckpoints.length ? "跳过摸底" : "跳过本段"}</button>
                <button onClick={() => void sendMain("直接查看完整答案", undefined, { kind: "DIRECT_ANSWER" })} disabled={busy}><FileSearch size={14} />直接看答案</button>
              </div>
            </div>
            <div className="message-stream" data-testid="teaching-stream">
              {currentTeachingMessages.map((message) => (
                <div key={message.id} className={`message-row ${message.role}`}>
                  <div className="avatar">{message.role === "assistant" ? <img src="/assistant-avatar.jpg" alt="助教头像" width={32} height={32} /> : <UserRound size={17} />}</div>
                  <div className="message-bubble">
                    <MarkdownMath content={message.content} />
                    {message.archivedVersion && <small>来自答案 v{message.archivedVersion}</small>}
                  </div>
                </div>
              ))}

              {mainThinking && (
                <div className="message-row assistant thinking-row" aria-live="polite" aria-label="千问正在思考">
                  <div className="avatar"><img src="/assistant-avatar.jpg" alt="" width={32} height={32} /></div>
                  <div className="thinking-indicator"><span /><span /><span /><small>正在思考</small></div>
                </div>
              )}

              {!!pendingKnowledgeCheckpoints.length && !mainThinking && (
                <div className="knowledge-card" data-testid="knowledge-checkpoint">
                  <div className="knowledge-card-heading">
                    <strong>开始前，先了解你的基础</strong>
                    <span>请一次完成，讲解会据此调整详略</span>
                  </div>
                  <div className="knowledge-survey-list">
                    {pendingKnowledgeCheckpoints.map((checkpoint, index) => (
                      <section key={checkpoint.id} className="knowledge-survey-item">
                        <div className="knowledge-item-title"><b>{index + 1}</b><MarkdownMath content={checkpoint.question} className="knowledge-question" /></div>
                        <div className="knowledge-options">
                          {([
                            ["KNOWN", "我已了解"],
                            ["UNCERTAIN", "我不太清楚"],
                            ["UNKNOWN", "我完全不了解"],
                            ["OTHER", "其他"],
                          ] as const).map(([value, label]) => (
                            <button
                              key={value}
                              className={knowledgeAnswers[checkpoint.id] === value ? "selected" : ""}
                              onClick={() => setKnowledgeAnswers((current) => ({ ...current, [checkpoint.id]: value }))}
                              disabled={busy}
                            >{label}</button>
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                  {Object.values(knowledgeAnswers).includes("OTHER") && (
                    <textarea value={knowledgeNote} onChange={(event) => setKnowledgeNote(event.target.value)} placeholder="补充说明你的掌握情况（可选）" rows={2} />
                  )}
                  <button className="knowledge-submit" onClick={() => void submitKnowledgeSurvey()} disabled={busy || !knowledgeSurveyReady}>按这个情况开始讲解</button>
                </div>
              )}

              {project.rollbackPreview && (
                <div className="rollback-card" data-testid="rollback-preview">
                  <div className="rollback-title"><ArchiveRestore size={18} /><strong>回退：{project.rollbackPreview.title}</strong></div>
                  <dl>
                    <div><dt>回退原因</dt><dd>{project.rollbackPreview.reason}</dd></div>
                    <div><dt>保留内容</dt><dd>审题、已知条件与仍兼容的答案块</dd></div>
                    <div><dt>撤回内容</dt><dd>{project.rollbackPreview.invalidatedBlockIds?.length || 0} 个依赖旧方法的答案块</dd></div>
                    <div><dt>新方法</dt><dd>{project.rollbackPreview.newMethod}</dd></div>
                  </dl>
                  <div className="rollback-buttons">
                    <button onClick={() => setProject((current) => ({ ...current, rollbackPreview: null }))}>取消</button>
                    <button className="primary-button" onClick={confirmRollback}>确认回退并继续</button>
                  </div>
                </div>
              )}
              {currentStage === "DONE" && nextProblem && (
                <div className="completion-card">
                  <div><strong>本题讲解完成</strong><span>接下来是第{nextProblem.index}题：{nextProblem.title}</span></div>
                  <button onClick={() => void startProblem(nextProblem)} disabled={busy}>进入下一题<ChevronRight size={15} /></button>
                </div>
              )}
              <div ref={messageEndRef} />
            </div>
            <form className={`main-composer ${rollbackMode ? "rollback-mode" : ""}`} onSubmit={(event) => { event.preventDefault(); void sendMain(); }}>
              {rollbackMode && <div className="rollback-mode-label"><RotateCcw size={14} />回退模式：说明希望撤回的内容、原因和新要求</div>}
              <textarea
                ref={mainInputRef}
                data-testid="main-input"
                value={mainInput}
                onChange={(event) => setMainInput(event.target.value)}
                onKeyDown={(event) => handleComposerKeyDown(event, () => void sendMain())}
                placeholder={rollbackMode ? "说明要回到哪一步，以及希望换成什么方法" : "输入问题或你的思路"}
                rows={1}
              />
              <div><button type="button" className={`icon-button rollback-toggle ${rollbackMode ? "active-action" : ""}`} onClick={() => setRollbackMode((mode) => !mode)} aria-label="切换回退模式" title="回退做题步骤"><RotateCcw size={16} /></button><span>Enter 发送 · Shift + Enter 换行</span><button className="send-button" type="submit" disabled={busy || !mainInput.trim()}><Send size={17} /></button></div>
            </form>
          </section>

          {sideAssistantOpen && (
            <aside className="pane side-assistant" aria-label="知识助手">
              <div className="side-header"><div><MessageCircleQuestion size={18} /><strong>知识助手</strong></div><button className="icon-button" onClick={() => setSideAssistantOpen(false)}><X size={16} /></button></div>
              <div className="context-chip">{currentProblem ? `第${currentProblem.index}题 · ${currentProblem.title}` : "未选择题目"}</div>
              <div className="side-messages">
                {currentSideMessages.map((message) => (
                  <div key={message.id} className={`side-message ${message.role}`}><MarkdownMath content={message.content} /></div>
                ))}
                {sideThinking && <div className="side-thinking" aria-live="polite"><span /><span /><span /><small>正在思考</small></div>}
                <div ref={sideMessageEndRef} />
              </div>
              <form className="side-composer" onSubmit={(event) => { event.preventDefault(); void sendSide(); }}>
                <textarea ref={sideInputRef} data-testid="side-input" rows={1} value={sideInput} onChange={(event) => setSideInput(event.target.value)} onKeyDown={(event) => handleComposerKeyDown(event, () => void sendSide())} placeholder="给千问发送消息" />
                <button type="submit" disabled={busy || !sideInput.trim()}><Send size={15} /></button>
              </form>
            </aside>
          )}
        </div>
      </section>

      {newProjectOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="新建作业">
          <div className="modal-card">
            <div className="modal-heading"><div><span className="brand-mark"><Plus size={18} /></span><div><strong>新建作业</strong><p>上传作业 PDF 后，系统会自动识别并整理题目。</p></div></div><button className="icon-button" onClick={closeNewProject}><X size={18} /></button></div>
            <label>作业名称<input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="例如：概率论第 8 次作业" /></label>
            {selectedCourseForNewProject ? (
              <div className="project-context-lock"><Network size={18} /><span><strong>课程项目内作业</strong><small>将继承“{selectedCourseForNewProject.name}”的课件、课本、知识图谱和课程说明。</small></span></div>
            ) : (
              <div className="standalone-assignment-note"><MessageCircleQuestion size={18} /><span><strong>独立作业</strong><small>只使用本作业上传的题目和参考资料，不读取任何课程项目。</small></span></div>
            )}
            <>
              <button className={`pdf-dropzone ${newProjectFile ? "has-file" : ""}`} onClick={() => modalFileInput.current?.click()}>
                <Upload size={22} /><strong>{newProjectFile ? newProjectFile.name : "选择作业 PDF"}</strong><span>{pdfSummary || "文件会先上传，再由千问整理文字、图片和公式"}</span>
                {newProjectFile && (pdfParsing || pdfProgress === 100) && (
                  <div className="pdf-progress" aria-live="polite">
                    <div className="pdf-progress-copy">
                      <span>{pdfParsing ? "正在上传、识别与分题" : "识别完成"}</span>
                      <span>{pdfProgress}%{pdfParsing ? ` · ${pdfRemainingSeconds > 0 ? `预计剩余${formatEstimate(pdfRemainingSeconds).replace("约 ", "")}` : "即将完成"}` : ""}</span>
                    </div>
                    <div className="pdf-progress-track"><i style={{ width: `${pdfProgress}%` }} /></div>
                    {pdfParsing && <small>切换文件会自动取消上一份；网络波动会自动退避重试</small>}
                  </div>
                )}
              </button>
              {pdfParsing && <button className="cancel-pdf-button" onClick={() => { pdfRequestRef.current?.controller.abort(); pdfRequestRef.current = null; setPdfParsing(false); setPdfSummary("已取消识别，可以重新选择文件。"); }}>取消本次识别</button>}
              <input ref={modalFileInput} className="sr-only" type="file" accept=".pdf,application/pdf" onChange={(event) => { const file = event.target.files?.[0]; if (file) void prepareProjectPdf(file); event.target.value = ""; }} />
            </>
            <button className={`reference-dropzone ${referenceFiles.length ? "has-file" : ""}`} onClick={() => referenceFileInput.current?.click()}>
              <FileSearch size={20} />
              <span><strong>{referenceFiles.length ? `已选择 ${referenceFiles.length} 份课程资料` : "添加老师课件或参考资料（可选）"}</strong><small>支持 PDF、图片、TXT、Markdown；PPT 请先导出为 PDF</small></span>
            </button>
            <input
              ref={referenceFileInput}
              className="sr-only"
              type="file"
              multiple
              accept=".pdf,.txt,.md,.markdown,image/png,image/jpeg,image/webp,image/bmp"
              onChange={(event) => {
                setReferenceFiles(Array.from(event.target.files || []));
                event.target.value = "";
              }}
            />
            {!!referenceFiles.length && (
              <div className="reference-file-list">
                {referenceFiles.map((file) => <span key={`${file.name}-${file.size}`}>{file.name}</span>)}
                <button onClick={() => setReferenceFiles([])}>清空</button>
              </div>
            )}
            <label>补充说明（可选）<textarea data-testid="assignment-input" value={assignmentText} onChange={(event) => setAssignmentText(event.target.value)} rows={3} placeholder="例如：只使用课上讲过的方法" /></label>
            <div className="modal-actions"><button onClick={closeNewProject}>取消</button><button className="primary-button" onClick={() => void createProject()} disabled={busy || !newProjectName.trim() || !newProjectFile}>{pdfParsing ? "立即创建，后台整理" : "创建并导入"}</button></div>
          </div>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
