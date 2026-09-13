import { env } from "cloudflare:workers";
import { extractReferenceMaterialWithModel } from "./model-provider";
import type {
  CourseGraph,
  CourseMaterial,
  CourseOutline,
  ExplanationArtifact,
  KnowledgeEdge,
  KnowledgeNode,
  MaterialChunk,
  ProblemKnowledgeLink,
  ReviewRoute,
  ReviewRouteInput,
  SourceRef,
} from "./course-types";
import { courseUid } from "./course-types";
import { mathTextToPlainLabel, normalizeLatexFormula, repairMathText } from "./math-text";
import { runModelCandidates } from "./model-retry";
import { parseModelJson } from "./model-json";

type RuntimeEnv = {
  MODEL_API_KEY?: string;
  MODEL_BASE_URL?: string;
  MODEL_NAME?: string;
  MODEL_FAST?: string;
  MODEL_SOLVER?: string;
  MODEL_REVIEW?: string;
  TOKEN_PLAN_API_KEY?: string;
  TOKEN_PLAN_BASE_URL?: string;
  TOKEN_PLAN_MODEL?: string;
  TOKEN_PLAN_FAST_MODEL?: string;
  TOKEN_PLAN_SOLVER_MODEL?: string;
  TOKEN_PLAN_REVIEW_MODEL?: string;
  DOCUMENT_SERVICE_URL?: string;
  DOCUMENT_SERVICE_TOKEN?: string;
  MODEL_TIMEOUT_MS?: string;
};

type Message = { role: "system" | "user" | "assistant"; content: string };

function runtimeConfig() {
  const bindings = env as unknown as RuntimeEnv;
  const compatibleKey = bindings.MODEL_API_KEY || process.env.MODEL_API_KEY;
  const tokenPlanApiKey = compatibleKey || bindings.TOKEN_PLAN_API_KEY || process.env.TOKEN_PLAN_API_KEY || "";
  const tokenPlanBaseUrl = ((compatibleKey ? bindings.MODEL_BASE_URL || process.env.MODEL_BASE_URL : bindings.TOKEN_PLAN_BASE_URL || process.env.TOKEN_PLAN_BASE_URL) || (compatibleKey ? "" : "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1")).replace(/\/$/, "");
  const tokenPlanModel = (compatibleKey ? bindings.MODEL_NAME || process.env.MODEL_NAME : bindings.TOKEN_PLAN_MODEL || process.env.TOKEN_PLAN_MODEL) || "qwen3.7-plus";
  const tokenPlanFastModel = (compatibleKey ? bindings.MODEL_FAST || process.env.MODEL_FAST : bindings.TOKEN_PLAN_FAST_MODEL || process.env.TOKEN_PLAN_FAST_MODEL) || tokenPlanModel;
  const solverModel = (compatibleKey ? bindings.MODEL_SOLVER || process.env.MODEL_SOLVER : bindings.TOKEN_PLAN_SOLVER_MODEL || process.env.TOKEN_PLAN_SOLVER_MODEL) || tokenPlanModel;
  const reviewModel = (compatibleKey ? bindings.MODEL_REVIEW || process.env.MODEL_REVIEW : bindings.TOKEN_PLAN_REVIEW_MODEL || process.env.TOKEN_PLAN_REVIEW_MODEL) || tokenPlanModel;
  const documentServiceUrl = (bindings.DOCUMENT_SERVICE_URL || process.env.DOCUMENT_SERVICE_URL || "").replace(/\/$/, "");
  const documentServiceToken = bindings.DOCUMENT_SERVICE_TOKEN || process.env.DOCUMENT_SERVICE_TOKEN || "";
  const modelTimeoutMs = Math.max(30_000, Number(bindings.MODEL_TIMEOUT_MS || process.env.MODEL_TIMEOUT_MS || 90_000));
  if (!tokenPlanApiKey || !tokenPlanBaseUrl) {
    throw new Error("尚未配置阿里云 Token Plan API Key。LearnFlow 不会回退到私有百炼 Key或固定图谱。");
  }
  return {
    model: tokenPlanModel,
    fastModel: tokenPlanFastModel,
    solverModel,
    reviewModel,
    tokenPlanApiKey,
    tokenPlanBaseUrl,
    documentServiceUrl,
    documentServiceToken,
    modelTimeoutMs,
  };
}

function parseJson<T>(text: string): T {
  return parseModelJson<T>(text);
}

async function modelText(messages: Message[], options: { structured?: boolean; maxTokens?: number; fast?: boolean; signal?: AbortSignal } = {}) {
  const config = runtimeConfig();
  const budget = options.signal || AbortSignal.timeout(150_000);
  const primaryModel = options.fast ? config.fastModel : config.model;
  const invoke = async (model: string) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`模型响应超过 ${config.modelTimeoutMs}ms`)), config.modelTimeoutMs);
    try {
    const response = await fetch(`${config.tokenPlanBaseUrl}/chat/completions`, {
      signal: AbortSignal.any([budget, controller.signal]),
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.tokenPlanApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: options.structured ? 0.15 : 0.45,
        enable_thinking: false,
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
        ...(options.structured ? { response_format: { type: "json_object" } } : {}),
        messages,
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      const error = new Error(`模型调用失败（${response.status}）：${detail.slice(0, 320)}`) as Error & { status?: number; detail?: string };
      error.status = response.status;
      error.detail = detail;
      throw error;
    }
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("模型返回了空内容。");
    return content;
    } finally {
      clearTimeout(timeout);
    }
  };
  const content = await runModelCandidates(
    [primaryModel, options.fast ? config.model : config.reviewModel, config.solverModel, config.model],
    (model) => invoke(model),
    { attemptsPerModel: 1, signal: budget },
  );
  return options.structured ? content : repairMathText(content);
}

async function modelJson<T>(messages: Message[], maxTokens = 16000, fast = false): Promise<T> {
  const signal = AbortSignal.timeout(150_000);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const content = await modelText(
        attempt === 0
          ? messages
          : [...messages, { role: "user", content: "上次 JSON 不完整或无法解析。请删去重复文字，只返回字段完整、闭合、可解析的 JSON。" }],
        { structured: true, maxTokens, fast, signal },
      );
      return parseJson<T>(content);
    } catch (error) {
      lastError = error;
      if (signal.aborted || !(error instanceof SyntaxError || /JSON|json|结构化/.test(error instanceof Error ? error.message : ""))) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("模型结构化输出失败。");
}

export async function parseCourseMaterial(bytes: Uint8Array, material: CourseMaterial, signal?: AbortSignal) {
  const config = runtimeConfig();
  if (config.documentServiceUrl) {
    const form = new FormData();
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    form.set("file", new File([copy.buffer], material.name, { type: material.mimeType }));
    form.set("mode", "course_structure");
    const response = await fetch(`${config.documentServiceUrl}/parse`, {
      signal,
      method: "POST",
      headers: config.documentServiceToken ? { Authorization: `Bearer ${config.documentServiceToken}` } : undefined,
      body: form,
    });
    if (response.ok) {
      const payload = (await response.json()) as { text?: string; markdown?: string; pageCount?: number };
      const text = (payload.markdown || payload.text || "").trim();
      if (text) return { text, pageCount: payload.pageCount };
    }
  }

  const raw = await extractReferenceMaterialWithModel(bytes, material.name, material.mimeType, signal);
  const normalized = raw.trim();
  if (!normalized) throw new Error("文档模型没有提取出可用的课程内容。");
  // document_parsing 已经返回带标题、公式和版面顺序的结构化文本。
  // 直接入库能省去一次长上下文模型调用，也避免二次改写老师的原文。
  return { text: /^#{1,6}\s/m.test(normalized) ? normalized : `# ${material.name}\n\n${normalized}` };
}

function pageMarker(line: string) {
  const match = line.match(/^\s*(?:#{1,6}\s*)?(?:page\s*|第\s*)(\d+)\s*(?:页)?\s*$/i)
    || line.match(/(?:page\s*|第\s*)(\d+)\s*页/i);
  return match ? Number(match[1]) : undefined;
}

export function chunkCourseMaterial(material: CourseMaterial, text: string): MaterialChunk[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const chunks: MaterialChunk[] = [];
  let heading = material.name;
  let page: number | undefined;
  let buffer: string[] = [];
  let sequence = 0;
  const flush = () => {
    const content = buffer.join("\n").trim();
    if (!content) return;
    const sourceRef: SourceRef = {
      materialId: material.id,
      materialName: material.name,
      page,
      section: heading,
      excerpt: content.slice(0, 260),
      locator: page ? `第 ${page} 页` : heading,
    };
    chunks.push({
      id: `${material.id}_chunk_${sequence + 1}`,
      courseId: material.courseId,
      materialId: material.id,
      sequence,
      heading,
      text: content,
      page,
      sourceRef,
    });
    sequence += 1;
    buffer = [];
  };

  for (const line of lines) {
    const nextPage = pageMarker(line);
    if (nextPage) page = nextPage;
    if (/^#{1,6}\s+\S/.test(line)) {
      flush();
      heading = line.replace(/^#{1,6}\s+/, "").trim();
      buffer.push(line);
      continue;
    }
    buffer.push(line);
    if (buffer.join("\n").length >= 3200) flush();
  }
  flush();
  return chunks;
}

function compactChunkCatalog(chunks: MaterialChunk[], maxChars = 190000) {
  let total = 0;
  const selected: Array<{ id: string; materialId: string; materialName: string; heading: string; page?: number; text: string }> = [];
  for (const chunk of chunks) {
    if (total >= maxChars) break;
    const text = chunk.text.slice(0, Math.min(6000, maxChars - total));
    selected.push({
      id: chunk.id,
      materialId: chunk.materialId,
      materialName: chunk.sourceRef.materialName,
      heading: chunk.heading,
      page: sourceRefForChunk(chunk, chunks).page,
      text,
    });
    total += text.length;
  }
  return selected;
}

type OutlineProgress = (
  stage: string,
  progress: number,
  detail: string,
  partialOutline?: CourseOutline,
) => void | Promise<void>;

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textOf(value: unknown) {
  return typeof value === "string" ? repairMathText(value).trim() : "";
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.map(textOf).filter(Boolean) : [];
}

function stableOutlineId(title: string, index: number, parent = "chapter") {
  let hash = 2166136261;
  for (const character of `${parent}:${title}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${parent}_${index + 1}_${(hash >>> 0).toString(36)}`;
}

function titleKey(title: string) {
  return title
    .toLowerCase()
    .replace(/第?[一二三四五六七八九十百\d]+[章节讲单元课时.-]*/g, "")
    .replace(/[\s【】()（）《》：:，,。.!！?？_-]+/g, "");
}

function uniqueSourceRefs(refs: SourceRef[]) {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.materialId}:${ref.page ?? ref.slide ?? ""}:${ref.section || ""}:${ref.excerpt.slice(0, 80)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function sourceRefForChunk(chunk: MaterialChunk, allChunks: MaterialChunk[] = [chunk]): SourceRef {
  const directPage = chunk.page ?? pageMarker(chunk.heading) ?? pageMarker(chunk.text.split("\n", 1)[0] || "");
  const precedingPage = directPage || allChunks
    .filter((candidate) => candidate.materialId === chunk.materialId && candidate.sequence <= chunk.sequence)
    .sort((left, right) => right.sequence - left.sequence)
    .map((candidate) => candidate.page ?? pageMarker(candidate.heading) ?? pageMarker(candidate.text.split("\n", 1)[0] || ""))
    .find((candidatePage): candidatePage is number => Boolean(candidatePage));
  return {
    ...chunk.sourceRef,
    page: precedingPage,
    locator: precedingPage ? `第 ${precedingPage} 页` : chunk.sourceRef.locator,
  };
}

function wordsForMatch(value: string) {
  return value
    .toLowerCase()
    .split(/[\s，。；、：:【】()（）《》/\\_-]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 1);
}

function bestChunksForSection(title: string, summary: string, chunks: MaterialChunk[], rawRefs: unknown[]) {
  const materialIds = new Set<string>();
  const materialNames = new Set<string>();
  const pages = new Set<number>();
  const sections = new Set<string>();
  for (const raw of rawRefs) {
    const ref = recordOf(raw);
    if (!ref) continue;
    const materialId = textOf(ref.materialId ?? ref.documentId);
    const materialName = textOf(ref.materialName ?? ref.documentName ?? ref.fileName);
    const section = textOf(ref.section ?? ref.heading);
    const page = Number(ref.page ?? ref.slide);
    if (materialId) materialIds.add(materialId);
    if (materialName) materialNames.add(materialName);
    if (section) sections.add(section);
    if (Number.isFinite(page) && page > 0) pages.add(page);
  }
  const tokens = wordsForMatch(`${title} ${summary} ${[...sections].join(" ")}`);
  return chunks
    .map((chunk) => {
      let score = 0;
      if (materialIds.has(chunk.materialId)) score += 20;
      if (materialNames.has(chunk.sourceRef.materialName)) score += 16;
      if (chunk.page && pages.has(chunk.page)) score += 12;
      const haystack = `${chunk.heading}\n${chunk.text}`.toLowerCase();
      for (const token of tokens) if (haystack.includes(token)) score += 2;
      return { chunk, score };
    })
    .sort((left, right) => right.score - left.score || left.chunk.sequence - right.chunk.sequence)
    .filter((item, index) => item.score > 0 || index === 0)
    .slice(0, 4)
    .map(({ chunk }) => chunk);
}

function sectionArrayFrom(payload: unknown, depth = 0): { root: Record<string, unknown>; sections: unknown[] } | undefined {
  if (depth > 4) return undefined;
  if (Array.isArray(payload)) return { root: {}, sections: payload };
  const record = recordOf(payload);
  if (!record) return undefined;
  for (const key of ["sections", "chapters", "modules", "units", "courseSections", "course_outline"]) {
    if (Array.isArray(record[key])) return { root: record, sections: record[key] as unknown[] };
  }
  for (const key of ["outline", "courseOutline", "data", "result", "output"]) {
    const nested = sectionArrayFrom(record[key], depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function normalizeOutlineSections(rawSections: unknown[], chunks: MaterialChunk[], parent = "chapter"): CourseOutline["sections"] {
  const normalized: CourseOutline["sections"] = [];
  rawSections.forEach((raw, rawIndex) => {
    const section = recordOf(raw);
    if (!section) return;
    const title = mathTextToPlainLabel(textOf(section.title ?? section.name ?? section.chapter ?? section.label ?? section.topic));
    if (!title) return;
    const summary = textOf(section.summary ?? section.description ?? section.overview ?? section.purpose)
      || `本部分围绕“${title}”整理课程资料中的核心内容。`;
    const rawRefs = Array.isArray(section.sourceRefs)
      ? section.sourceRefs
      : Array.isArray(section.sources) ? section.sources : Array.isArray(section.evidence) ? section.evidence : [];
    const matchedChunks = bestChunksForSection(title, summary, chunks, rawRefs);
    if (!matchedChunks.length) return;
    const childPayload = section.children ?? section.subsections ?? section.subSections ?? section.topics;
    const children = Array.isArray(childPayload)
      ? normalizeOutlineSections(childPayload, chunks, `${parent}_${rawIndex + 1}`)
      : [];
    normalized.push({
      id: textOf(section.id) || stableOutlineId(title, normalized.length, parent),
      title,
      summary,
      order: Number.isFinite(Number(section.order)) ? Number(section.order) : normalized.length + 1,
      sourceRefs: uniqueSourceRefs(matchedChunks.map((chunk) => sourceRefForChunk(chunk, chunks))),
      children,
    });
  });
  return normalized.sort((left, right) => left.order - right.order).map((section, index) => ({ ...section, order: index + 1 }));
}

/**
 * Model providers frequently wrap otherwise valid structured output in `data`,
 * or use `chapters`/`modules` instead of `sections`. Normalize those harmless
 * variations before treating a course outline as failed.
 */
export function normalizeCourseOutlineResult(payload: unknown, courseName: string, chunks: MaterialChunk[]): CourseOutline | null {
  const located = sectionArrayFrom(payload);
  if (!located) return null;
  const sections = normalizeOutlineSections(located.sections, chunks);
  if (!sections.length) return null;
  return {
    title: textOf(located.root.title ?? located.root.courseName) || courseName,
    summary: textOf(located.root.summary ?? located.root.overview) || `${courseName}课程结构`,
    examScopeNotes: stringList(located.root.examScopeNotes ?? located.root.exam_scope_notes ?? located.root.examNotes),
    conflicts: stringList(located.root.conflicts ?? located.root.materialConflicts),
    sections,
  };
}

function mergeSectionLists(sections: CourseOutline["sections"]): CourseOutline["sections"] {
  const merged: CourseOutline["sections"] = [];
  const indexes = new Map<string, number>();
  for (const section of sections) {
    const normalizedTitle = titleKey(section.title) || section.title;
    const genericTitle = /^(小结|总结|课程回顾|本次课小结|上次课回顾|复习)$/i.test(normalizedTitle);
    const sourceScope = [...new Set(section.sourceRefs.map((ref) => ref.materialId))].sort().join("_");
    const key = genericTitle ? `${normalizedTitle}:${sourceScope}` : normalizedTitle;
    const existingIndex = indexes.get(key);
    if (existingIndex === undefined) {
      indexes.set(key, merged.length);
      merged.push({ ...section, sourceRefs: uniqueSourceRefs(section.sourceRefs), children: mergeSectionLists(section.children) });
      continue;
    }
    const existing = merged[existingIndex];
    merged[existingIndex] = {
      ...existing,
      summary: section.summary.length > existing.summary.length ? section.summary : existing.summary,
      sourceRefs: uniqueSourceRefs([...existing.sourceRefs, ...section.sourceRefs]),
      children: mergeSectionLists([...existing.children, ...section.children]),
    };
  }
  return merged.map((section, index) => ({ ...section, order: index + 1 }));
}

export function mergeCourseOutlines(courseName: string, outlines: CourseOutline[]): CourseOutline {
  return {
    title: courseName,
    summary: outlines.map((outline) => outline.summary).find(Boolean) || `${courseName}课程结构`,
    examScopeNotes: [...new Set(outlines.flatMap((outline) => outline.examScopeNotes))],
    conflicts: [...new Set(outlines.flatMap((outline) => outline.conflicts))],
    sections: mergeSectionLists(outlines.flatMap((outline) => outline.sections)),
  };
}

function cleanHeading(value: string) {
  return mathTextToPlainLabel(value.replace(/^#{1,6}\s*/, "").replace(/\.(pdf|pptx?|docx?)$/i, "").trim());
}

export function buildFallbackCourseOutline(courseName: string, chunks: MaterialChunk[]): CourseOutline {
  const groups = new Map<string, MaterialChunk[]>();
  for (const chunk of chunks) {
    const group = groups.get(chunk.materialId) || [];
    group.push(chunk);
    groups.set(chunk.materialId, group);
  }
  const sections = [...groups.values()].map((materialChunks, index) => {
    const first = materialChunks[0];
    const materialTitle = cleanHeading(first.sourceRef.materialName) || `课程资料 ${index + 1}`;
    const headings = [...new Set(materialChunks.map((chunk) => cleanHeading(chunk.heading)).filter(Boolean))]
      .filter((heading) => titleKey(heading) !== titleKey(materialTitle))
      .slice(0, 12);
    const children = headings.map((heading, childIndex) => {
      const matching = materialChunks.filter((chunk) => cleanHeading(chunk.heading) === heading);
      return {
        id: stableOutlineId(heading, childIndex, `chapter_${index + 1}`),
        title: heading,
        summary: `来自 ${first.sourceRef.materialName} 的课程小节。`,
        order: childIndex + 1,
        sourceRefs: uniqueSourceRefs((matching.length ? matching : materialChunks).slice(0, 3).map((chunk) => sourceRefForChunk(chunk, materialChunks))),
        children: [],
      } satisfies CourseOutline["sections"][number];
    });
    return {
      id: stableOutlineId(materialTitle, index),
      title: materialTitle,
      summary: `根据 ${first.sourceRef.materialName} 的真实标题和页面顺序整理。`,
      order: index + 1,
      sourceRefs: uniqueSourceRefs(materialChunks.slice(0, 4).map((chunk) => sourceRefForChunk(chunk, materialChunks))),
      children,
    } satisfies CourseOutline["sections"][number];
  });
  return {
    title: courseName,
    summary: "根据已解析课件的标题层级生成的可确认初始目录。",
    examScopeNotes: [],
    conflicts: [],
    sections,
  };
}

async function extractMaterialOutline(courseName: string, chunks: MaterialChunk[]) {
  const materialName = chunks[0]?.sourceRef.materialName || "课程资料";
  const messages: Message[] = [
    {
      role: "system",
      content: `你是课程目录抽取 Agent。只整理当前这一份老师资料中的真实章节和小节，不得凭空补充。不要把每一页都当成章节；应根据标题层级、目录页、讲次主题和内容连续性组织结构。每个章节必须绑定输入中真实存在的 sourceRefs。只返回 JSON 对象，根字段必须是 outline，outline 内必须包含 sections 数组。`,
    },
    {
      role: "user",
      content: JSON.stringify({
        courseName,
        materialName,
        chunks: compactChunkCatalog(chunks, 70000),
        requiredShape: {
          outline: {
            title: courseName,
            summary: "本资料在课程中的作用",
            examScopeNotes: [],
            conflicts: [],
            sections: [{ id: "chapter_1", title: "章节", summary: "本章作用", order: 1, sourceRefs: [], children: [] }],
          },
        },
      }),
    },
  ];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const payload = await modelJson<unknown>(attempt === 0 ? messages : [
        ...messages,
        { role: "user", content: "上次返回没有形成非空的 outline.sections。请核对输入中的真实标题，并严格按 requiredShape 返回至少一个有来源的章节。" },
      ], 10000);
      const outline = normalizeCourseOutlineResult(payload, courseName, chunks);
      if (outline) return { outline, fallback: false };
    } catch {
      // The deterministic heading fallback below keeps one malformed model
      // response from invalidating every other lecture in the course.
    }
  }
  return { outline: buildFallbackCourseOutline(courseName, chunks), fallback: true };
}

export async function generateCourseOutline(
  courseName: string,
  chunks: MaterialChunk[],
  onProgress?: OutlineProgress,
): Promise<CourseOutline> {
  if (!chunks.length) throw new Error("课程资料尚未完成解析，无法生成课程目录。");
  const groups = [...chunks.reduce((map, chunk) => {
    const group = map.get(chunk.materialId) || [];
    group.push(chunk);
    map.set(chunk.materialId, group);
    return map;
  }, new Map<string, MaterialChunk[]>()).values()];
  const candidates = new Array<CourseOutline>(groups.length);
  let completed = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < groups.length) {
      const index = cursor;
      cursor += 1;
      const group = groups[index];
      const materialName = group[0]?.sourceRef.materialName || `课程资料 ${index + 1}`;
      const extracted = await extractMaterialOutline(courseName, group);
      candidates[index] = extracted.outline;
      completed += 1;
      const partial = mergeCourseOutlines(courseName, candidates.filter(Boolean));
      await onProgress?.(
        `OUTLINE_SOURCE_${index + 1}`,
        40 + Math.round((completed / groups.length) * 35),
        `${materialName} 已整理出 ${extracted.outline.sections.length} 个章节${extracted.fallback ? "（使用课件标题降级整理）" : ""}`,
        partial,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, groups.length) }, () => worker()));

  const deterministicMerge = mergeCourseOutlines(courseName, candidates.filter(Boolean));
  await onProgress?.("OUTLINE_MERGE", 82, "正在合并重复章节、课件顺序和来源页码", deterministicMerge);
  if (deterministicMerge.sections.length === 1 || candidates.length === 1) return deterministicMerge;

  try {
    const payload = await modelJson<unknown>([
      {
        role: "system",
        content: "你是课程目录合并 Agent。合并多份课件目录中的同义章节，保留课程顺序和全部真实来源。不得增加候选目录中不存在的章节；不得删除 sourceRefs。只返回 JSON，根字段为 outline，内部必须包含非空 sections。",
      },
      {
        role: "user",
        content: JSON.stringify({ courseName, candidateOutlines: candidates, requiredRoot: "outline.sections" }),
      },
    ], 12000);
    const merged = normalizeCourseOutlineResult(payload, courseName, chunks);
    if (merged?.sections.length) return merged;
  } catch {
    // A model merge is an enhancement, not a single point of failure. The
    // deterministic merge still contains every successfully extracted source.
  }
  return deterministicMerge.sections.length ? deterministicMerge : buildFallbackCourseOutline(courseName, chunks);
}

type NodeDraft = Omit<KnowledgeNode, "graphId" | "courseId" | "learningStatus" | "order"> & { order?: number };
type EdgeDraft = Omit<KnowledgeEdge, "graphId" | "courseId">;

function normalizeSourceRefText(ref: SourceRef): SourceRef {
  return {
    ...ref,
    section: ref.section ? mathTextToPlainLabel(ref.section) : ref.section,
    excerpt: repairMathText(ref.excerpt || ""),
    locator: ref.locator ? repairMathText(ref.locator) : ref.locator,
  };
}

function normalizeNodeDraftText(node: NodeDraft): NodeDraft {
  return {
    ...node,
    title: mathTextToPlainLabel(node.title || ""),
    shortSummary: repairMathText(node.shortSummary || ""),
    formula: node.formula ? normalizeLatexFormula(node.formula) : undefined,
    conditions: Array.isArray(node.conditions) ? node.conditions.map((item) => repairMathText(String(item))).filter(Boolean) : [],
    aliases: Array.isArray(node.aliases) ? node.aliases.map((item) => mathTextToPlainLabel(String(item))).filter(Boolean) : [],
    sourceRefs: Array.isArray(node.sourceRefs) ? node.sourceRefs.map(normalizeSourceRefText) : [],
  };
}

function normalizeEdgeDraftText(edge: EdgeDraft): EdgeDraft {
  return {
    ...edge,
    label: repairMathText(edge.label || ""),
    sourceRefs: Array.isArray(edge.sourceRefs) ? edge.sourceRefs.map(normalizeSourceRefText) : [],
  };
}

function chunksForSection(section: CourseOutline["sections"][number], chunks: MaterialChunk[]) {
  const sourceMaterialIds = new Set(section.sourceRefs.map((ref) => ref.materialId));
  const tokens = `${section.title} ${section.summary}`.toLowerCase().split(/\s+|[，。；、：]/).filter((token) => token.length > 1);
  const ranked = chunks.map((chunk) => {
    const haystack = `${chunk.heading}\n${chunk.text}`.toLowerCase();
    let score = sourceMaterialIds.has(chunk.materialId) ? 5 : 0;
    for (const token of tokens) if (haystack.includes(token)) score += 1;
    return { chunk, score };
  }).sort((a, b) => b.score - a.score);
  return ranked.slice(0, 18).map(({ chunk }) => chunk);
}

async function extractSectionNodes(
  courseId: string,
  graphId: string,
  section: CourseOutline["sections"][number],
  chunks: MaterialChunk[],
): Promise<NodeDraft[]> {
  const result = await modelJson<{ nodes: NodeDraft[] }>([
    {
      role: "system",
      content: `你是知识原子 Agent。只从输入章节和真实资料片段提取概念、定义、定理、公式、方法、题型、例题和易错条件。宽泛概念要拆到可以单独解释和引用的粒度。每个节点必须有 sourceRefs；资料没有直接支持但对结构必要的补充节点必须 generatedFrom=AI_SUPPLEMENT、confidence<=0.65。公式节点必须保存 formula 和 conditions。不得生成练习题。只返回 JSON。`,
    },
    {
      role: "user",
      content: JSON.stringify({
        courseId,
        graphId,
        section,
        chunks: compactChunkCatalog(chunksForSection(section, chunks), 70000),
        allowedTypes: ["CONCEPT", "DEFINITION", "THEOREM", "FORMULA", "METHOD", "QUESTION_TYPE", "EXAMPLE", "WARNING"],
        nodeShape: {
          id: "node_unique_slug",
          type: "CONCEPT",
          title: "知识点名称",
          shortSummary: "一句话说明",
          importance: "CORE|IMPORTANT|SUPPORTING|OPTIONAL",
          difficulty: "FOUNDATION|INTERMEDIATE|ADVANCED",
          examWeight: "0-100；只能依据老师强调、重复出现、例题和往年题证据",
          confidence: "0-1",
          sourceRefs: [],
          generatedFrom: "COURSE_MATERIAL|AI_SUPPLEMENT",
          chapterId: section.id,
          formula: "可选 LaTeX",
          conditions: [],
          aliases: [],
          metadata: { examEvidence: [] },
        },
      }),
    },
  ], 22000);
  return Array.isArray(result.nodes) ? result.nodes.map(normalizeNodeDraftText) : [];
}

function normalizeTitle(value: string) {
  return value.toLowerCase().replace(/[\s（）()，,。·\-—_:：]/g, "");
}

function dedupeNodes(nodes: NodeDraft[]) {
  const byTitle = new Map<string, NodeDraft>();
  for (const rawNode of nodes) {
    const node = normalizeNodeDraftText(rawNode);
    const key = normalizeTitle(node.title || "");
    if (!key) continue;
    const current = byTitle.get(key);
    if (!current) {
      byTitle.set(key, node);
      continue;
    }
    const currentScore = current.sourceRefs?.length || 0;
    const nextScore = node.sourceRefs?.length || 0;
    const winner = nextScore > currentScore ? node : current;
    const loser = winner === node ? current : node;
    winner.sourceRefs = [...(winner.sourceRefs || []), ...(loser.sourceRefs || [])].filter(
      (ref, index, all) => all.findIndex((item) => `${item.materialId}:${item.page || item.slide || item.section}:${item.excerpt}` === `${ref.materialId}:${ref.page || ref.slide || ref.section}:${ref.excerpt}`) === index,
    );
    winner.aliases = [...new Set([...(winner.aliases || []), ...(loser.aliases || [])])];
    winner.examWeight = Math.max(winner.examWeight || 0, loser.examWeight || 0);
    winner.confidence = Math.max(winner.confidence || 0, loser.confidence || 0);
    byTitle.set(key, winner);
  }
  return [...byTitle.values()];
}

async function generateRelations(outline: CourseOutline, nodes: NodeDraft[]): Promise<EdgeDraft[]> {
  const catalog = nodes.map((node) => ({
    id: node.id,
    title: node.title,
    type: node.type,
    chapterId: node.chapterId,
    summary: node.shortSummary,
    sourceRefs: node.sourceRefs,
  }));
  const result = await modelJson<{ edges: EdgeDraft[] }>([
    {
      role: "system",
      content: `你是课程知识关系 Agent。根据节点目录构建包含、前置、推导、使用、等价、相似、易混和题型应用关系。不得发明不存在的 node id。优先使用明确资料证据；仅凭学科逻辑推断的关系必须 inferred=true、confidence<=0.68，并说明 label。只返回 JSON。`,
    },
    {
      role: "user",
      content: JSON.stringify({
        outline,
        nodes: catalog,
        allowedTypes: ["CONTAINS", "PREREQUISITE_OF", "DERIVES", "USES", "EQUIVALENT_TO", "SIMILAR_TO", "CONFUSED_WITH", "APPLIES_TO", "EVIDENCED_BY", "RELATED_PROBLEM"],
        edgeShape: { id: "edge_unique", sourceNodeId: "node_id", targetNodeId: "node_id", type: "PREREQUISITE_OF", label: "关系说明", confidence: 0.8, inferred: false, sourceRefs: [] },
      }),
    },
  ], 22000);
  return Array.isArray(result.edges) ? result.edges.map(normalizeEdgeDraftText) : [];
}

function removeInvalidEdges(nodes: NodeDraft[], edges: EdgeDraft[]) {
  const ids = new Set(nodes.map((node) => node.id));
  const unique = new Map<string, EdgeDraft>();
  for (const edge of edges) {
    if (!ids.has(edge.sourceNodeId) || !ids.has(edge.targetNodeId) || edge.sourceNodeId === edge.targetNodeId) continue;
    const key = `${edge.sourceNodeId}:${edge.targetNodeId}:${edge.type}`;
    const current = unique.get(key);
    if (!current || edge.confidence > current.confidence) unique.set(key, edge);
  }

  const prerequisiteEdges = [...unique.values()]
    .filter((edge) => edge.type === "PREREQUISITE_OF")
    .sort((a, b) => b.confidence - a.confidence);
  const adjacency = new Map<string, Set<string>>();
  const accepted = new Set<string>();
  const hasPath = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return [...(adjacency.get(from) || [])].some((next) => hasPath(next, to, seen));
  };
  for (const edge of prerequisiteEdges) {
    if (hasPath(edge.targetNodeId, edge.sourceNodeId)) continue;
    if (!adjacency.has(edge.sourceNodeId)) adjacency.set(edge.sourceNodeId, new Set());
    adjacency.get(edge.sourceNodeId)!.add(edge.targetNodeId);
    accepted.add(`${edge.sourceNodeId}:${edge.targetNodeId}:${edge.type}`);
  }
  return [...unique.entries()]
    .filter(([key, edge]) => edge.type !== "PREREQUISITE_OF" || accepted.has(key))
    .map(([, edge]) => edge);
}

async function reviewGraph(nodes: NodeDraft[], edges: EdgeDraft[]) {
  return modelJson<{
    approved: boolean;
    missingCoreTopics: Array<{ title: string; reason: string; sourceRefs: SourceRef[] }>;
    nodeCorrections: Array<{ nodeId: string; shortSummary?: string; examWeight?: number; confidence?: number }>;
    edgeIdsToRemove: string[];
    warnings: string[];
  }>([
    {
      role: "system",
      content: `你是图谱评审与证据 Agent。检查课程主干覆盖、重复、错误关系、公式条件、来源完整性、AI 推断标记和考试重点证据。不要重写整个图谱，只输出必要纠正。不能仅凭常识把知识点标成必考。只返回 JSON。`,
    },
    {
      role: "user",
      content: JSON.stringify({
        nodes: nodes.map((node) => ({ id: node.id, title: node.title, type: node.type, summary: node.shortSummary, examWeight: node.examWeight, confidence: node.confidence, generatedFrom: node.generatedFrom, sourceRefs: node.sourceRefs, conditions: node.conditions })),
        edges,
      }),
    },
  ], 14000, true);
}

export async function generateCourseGraph(
  courseId: string,
  courseName: string,
  outline: CourseOutline,
  chunks: MaterialChunk[],
  onStage?: (stage: string, progress: number, detail: string) => void | Promise<void>,
): Promise<CourseGraph> {
  const timestamp = new Date().toISOString();
  const graphId = `graph_${courseId}`;
  const rootRef = outline.sections.flatMap((section) => section.sourceRefs).slice(0, 4);
  const root: NodeDraft = normalizeNodeDraftText({
    id: `course_root_${courseId}`,
    type: "COURSE",
    title: courseName,
    shortSummary: outline.summary,
    importance: "CORE",
    difficulty: "FOUNDATION",
    examWeight: 100,
    confidence: 1,
    sourceRefs: rootRef,
    generatedFrom: "COURSE_MATERIAL",
    conditions: [],
    aliases: [],
  });
  const chapters: NodeDraft[] = outline.sections.map((section, index) => normalizeNodeDraftText({
    id: section.id,
    type: "CHAPTER",
    title: section.title,
    shortSummary: section.summary,
    importance: "CORE",
    difficulty: "FOUNDATION",
    examWeight: 70,
    confidence: 0.98,
    sourceRefs: section.sourceRefs,
    generatedFrom: "COURSE_MATERIAL",
    chapterId: section.id,
    conditions: [],
    aliases: [],
    order: index + 1,
  }));

  await onStage?.("KNOWLEDGE_ATOMS", 38, "正在按章节提取定义、公式、方法、题型与易错点");
  const extractedBatches = await Promise.all(
    outline.sections.map((section) => extractSectionNodes(courseId, graphId, section, chunks)),
  );
  let drafts = dedupeNodes([root, ...chapters, ...extractedBatches.flat()]);
  drafts = drafts.map((node, index) => ({
    ...normalizeNodeDraftText(node),
    id: node.id || courseUid("node"),
    sourceRefs: Array.isArray(node.sourceRefs) ? node.sourceRefs : [],
    conditions: Array.isArray(node.conditions) ? node.conditions : [],
    aliases: Array.isArray(node.aliases) ? node.aliases : [],
    examWeight: Math.max(0, Math.min(100, Number(node.examWeight || 0))),
    confidence: Math.max(0, Math.min(1, Number(node.confidence || 0.5))),
    order: Number(node.order ?? index),
  }));
  await onStage?.("RELATIONS", 62, `已提取 ${drafts.length} 个候选知识节点，正在建立跨章节关系`);
  const chapterEdges: EdgeDraft[] = chapters.map((chapter, index) => normalizeEdgeDraftText({
    id: `edge_root_${index + 1}`,
    sourceNodeId: root.id,
    targetNodeId: chapter.id,
    type: "CONTAINS",
    label: "课程章节",
    confidence: 1,
    inferred: false,
    sourceRefs: chapter.sourceRefs,
  }));
  const atomChapterEdges: EdgeDraft[] = drafts
    .filter((node) => !["COURSE", "CHAPTER"].includes(node.type) && node.chapterId)
    .map((node) => normalizeEdgeDraftText({
      id: `edge_contains_${node.id}`,
      sourceNodeId: node.chapterId!,
      targetNodeId: node.id,
      type: "CONTAINS",
      label: "本章知识",
      confidence: 0.98,
      inferred: false,
      sourceRefs: node.sourceRefs,
    }));
  let edgeDrafts = removeInvalidEdges(drafts, [...chapterEdges, ...atomChapterEdges, ...(await generateRelations(outline, drafts))]);
  await onStage?.("REVIEW", 78, `已形成 ${edgeDrafts.length} 条关系，正在核验来源、重复节点与前置循环`);
  const review = await reviewGraph(drafts, edgeDrafts);
  const removeIds = new Set(review.edgeIdsToRemove || []);
  edgeDrafts = edgeDrafts.filter((edge) => !removeIds.has(edge.id));
  const corrections = new Map((review.nodeCorrections || []).map((item) => [item.nodeId, item]));
  drafts = drafts.map((node) => normalizeNodeDraftText({ ...node, ...(corrections.get(node.id) || {}) }));

  await onStage?.("LAYOUT", 90, "证据核验完成，正在生成章节树与依赖图数据");
  const nodes: KnowledgeNode[] = drafts.map((node, index) => ({
    ...normalizeNodeDraftText(node),
    graphId,
    courseId,
    learningStatus: "UNSEEN",
    order: Number(node.order ?? index),
  }));
  const edges: KnowledgeEdge[] = edgeDrafts.map((edge, index) => ({
    ...normalizeEdgeDraftText(edge),
    id: edge.id || `edge_${index + 1}`,
    graphId,
    courseId,
    sourceRefs: Array.isArray(edge.sourceRefs) ? edge.sourceRefs : [],
  }));
  return {
    id: graphId,
    courseId,
    title: `${mathTextToPlainLabel(courseName)}知识图谱`,
    version: 1,
    status: "READY",
    nodes,
    edges,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function graphNeighborhood(node: KnowledgeNode, graph: CourseGraph) {
  const relatedEdges = graph.edges.filter((edge) => edge.sourceNodeId === node.id || edge.targetNodeId === node.id);
  const relatedIds = new Set(relatedEdges.flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId]));
  return {
    edges: relatedEdges,
    nodes: graph.nodes.filter((item) => relatedIds.has(item.id)).map((item) => ({ id: item.id, title: item.title, type: item.type, summary: item.shortSummary })),
  };
}

export async function generateNodeExplanation(node: KnowledgeNode, graph: CourseGraph, evidenceChunks: MaterialChunk[]): Promise<ExplanationArtifact> {
  const requiredSections = [
    ["summary", "10 秒概括"],
    ["problem", "它解决什么问题"],
    ["example", "最直观的具体例子"],
    ["prerequisites", "前置知识"],
    ["intuition", "通俗解释"],
    ["definition", "正式定义"],
    ["symbols", "符号词典"],
    ["formula", "公式及适用条件"],
    ["derivation", "关键推导"],
    ["visual", "图形或概率直觉"],
    ["connections", "与其他知识点的联系"],
    ["confusions", "容易混淆的概念"],
    ["course_examples", "老师课件中的例题"],
    ["exam", "考试中常见的出现方式"],
    ["answer", "可以直接写在试卷上的总结"],
    ["sources", "资料出处"],
  ] as const;
  type ExplanationPayload = {
    title?: string;
    sections?: unknown;
    sourceRefs?: SourceRef[];
    artifact?: { title?: string; sections?: unknown; sourceRefs?: SourceRef[] };
  };
  const normalizeSections = (value: unknown): ExplanationArtifact["sections"] => {
    const titles = new Map<string, string>(requiredSections.map(([key, title]) => [key, title]));
    if (Array.isArray(value)) {
      return value.flatMap((item, index) => {
        if (typeof item === "string" && item.trim()) {
          const [key, title] = requiredSections[index] || ["summary", `讲解 ${index + 1}`];
          return [{ key, title, content: repairMathText(item.trim()) } as ExplanationArtifact["sections"][number]];
        }
        if (!item || typeof item !== "object") return [];
        const section = item as { key?: string; title?: string; content?: string; text?: string; markdown?: string };
        const key = section.key && titles.has(section.key) ? section.key : requiredSections[index]?.[0];
        const content = repairMathText((section.content || section.text || section.markdown || "").trim());
        if (!key || !content) return [];
        return [{ key, title: mathTextToPlainLabel(section.title || titles.get(key) || key), content } as ExplanationArtifact["sections"][number]];
      });
    }
    if (value && typeof value === "object") {
      return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
        if (!titles.has(key)) return [];
        const content = typeof entry === "string"
          ? repairMathText(entry.trim())
          : entry && typeof entry === "object"
            ? repairMathText(String((entry as { content?: unknown; text?: unknown }).content || (entry as { text?: unknown }).text || "").trim())
            : "";
        return content ? [{ key, title: titles.get(key)!, content } as ExplanationArtifact["sections"][number]] : [];
      });
    }
    return [];
  };
  const buildMessages = (repair?: ExplanationPayload): Message[] => [
    {
      role: "system",
      content: `你是大学课程知识学习台的主讲老师。语气要亲和、平等，像耐心的老师陪学生一起梳理，不要训话或故作高深。采用零前置、低认知负担、完整定义、具体例子和必要重复的讲解协议。先在内部核对，再一次输出组织完整的讲解；不展示草稿推理或不确定尝试。不得假设用户认识符号，每个新符号都要解释；关键变形不能跳步。课程资料优先，AI 补充必须明确标记。数学使用 $...$ 或 $$...$$。只返回 JSON。`,
    },
    {
      role: "user",
      content: JSON.stringify({
        node,
        neighborhood: graphNeighborhood(node, graph),
        evidence: compactChunkCatalog(evidenceChunks, 45000),
        requiredSections,
        outputShape: {
          title: node.title,
          sections: requiredSections.map(([key, title]) => ({ key, title, content: "完整 Markdown 讲解；无适用内容时说明原因，不能省略字段" })),
          sourceRefs: node.sourceRefs,
        },
        discipline: "简单知识可以压缩无关部分，复杂知识必须完整。资料没有支持的考试结论不得写成必考。",
        ...(repair ? { invalidPreviousOutput: repair, repairInstruction: "上一版章节结构不完整。严格按 outputShape 返回 sections 数组。" } : {}),
      }),
    },
  ];
  let result = await modelJson<ExplanationPayload>(buildMessages(), 16000);
  let payload = result.artifact || result;
  let sections = normalizeSections(payload.sections);
  if (sections.length < 8) {
    result = await modelJson<ExplanationPayload>(buildMessages(result), 16000);
    payload = result.artifact || result;
    sections = normalizeSections(payload.sections);
  }
  if (sections.length < 8) throw new Error("模型没有返回完整的知识讲解章节，请稍后重试。");
  const timestamp = new Date().toISOString();
  return {
    id: `explanation_${node.id}`,
    courseId: node.courseId,
    nodeId: node.id,
    title: mathTextToPlainLabel(payload.title || node.title),
    sections,
    sourceRefs: Array.isArray(payload.sourceRefs) && payload.sourceRefs.length ? payload.sourceRefs : node.sourceRefs,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function answerKnowledgeQuestion(
  node: KnowledgeNode,
  graph: CourseGraph,
  question: string,
  evidenceChunks: MaterialChunk[],
  history: Array<{ role: "user" | "assistant"; content: string }> = [],
) {
  return modelText([
    {
      role: "system",
      content: `你是 LearnFlow 知识学习台。语气亲和、自然，像一位愿意慢慢讲清楚的老师；先接住用户的问题，再通俗、严谨地回答。直接响应当前问题，不机械复述完整课程。先在内部核对，一次输出组织好的答案。课程资料与图谱优先；AI 补充必须明确说明。所有数学使用 LaTeX。不要展示草稿思维。`,
    },
    ...history.slice(-8),
    {
      role: "user",
      content: JSON.stringify({ node, neighborhood: graphNeighborhood(node, graph), evidence: compactChunkCatalog(evidenceChunks, 24000), question }),
    },
  ], { maxTokens: 6500, fast: true });
}

export async function compareKnowledgeNodes(nodes: KnowledgeNode[], graph: CourseGraph, evidenceChunks: MaterialChunk[]) {
  if (nodes.length < 2) throw new Error("至少选择两个知识点才能比较。");
  return modelText([
    {
      role: "system",
      content: `比较课程中的易混知识点。依次说明共同点、核心区别、符号区别、适用条件、缺失条件的后果、典型题目识别方式，并给出一张简洁对照表。只使用真实资料证据和明确标记的 AI 补充。数学使用 LaTeX。`,
    },
    { role: "user", content: JSON.stringify({ nodes, graphEdges: graph.edges, evidence: compactChunkCatalog(evidenceChunks, 60000) }) },
  ], { maxTokens: 8000, fast: true });
}

export async function generateReviewRoute(
  courseId: string,
  input: ReviewRouteInput,
  graph: CourseGraph,
): Promise<ReviewRoute> {
  type RawRouteItem = Partial<Omit<ReviewRoute["items"][number], "id" | "routeId" | "status">> & { day?: number; minutes?: number };
  type ReviewPayload = {
    summary?: string;
    items?: RawRouteItem[];
    days?: Array<{ dayIndex?: number; date?: string; items?: RawRouteItem[] }>;
    route?: ReviewPayload;
    reviewRoute?: ReviewPayload;
  };
  const buildMessages = (repair?: ReviewPayload): Message[] => [
    {
      role: "system",
      content: `你是期末冲刺路线 Agent。依据考试日期、每天时间、用户标记、知识图谱前置关系、老师重点证据和真实往年题证据安排复习。先安排关键前置与高频节点，不生成任何新练习题。没有资料证据时不得写“必考”。只返回 JSON。`,
    },
    {
      role: "user",
      content: JSON.stringify({
        input,
        nodes: graph.nodes.map((node) => ({ id: node.id, title: node.title, type: node.type, importance: node.importance, difficulty: node.difficulty, examWeight: node.examWeight, learningStatus: node.learningStatus, sourceRefs: node.sourceRefs, metadata: node.metadata })),
        prerequisiteEdges: graph.edges.filter((edge) => edge.type === "PREREQUISITE_OF" || edge.type === "CONTAINS"),
        rule: "每个 item 的 nodeIds 只能使用输入节点 id；总分钟数不能超过每天可用时间；日期不得晚于考试日。",
        outputShape: {
          summary: "整体复习策略",
          items: [{ dayIndex: 1, date: "YYYY-MM-DD", title: "当天主题", nodeIds: ["真实节点 id"], estimatedMinutes: 90, rationale: "为什么这样安排" }],
        },
        ...(repair ? { invalidPreviousOutput: repair, repairInstruction: "上一版没有可执行 items。严格按 outputShape 返回扁平 items 数组。" } : {}),
      }),
    },
  ];
  let result = await modelJson<ReviewPayload>(buildMessages(), 14000);
  let payload = result.route || result.reviewRoute || result;
  const flattenItems = (value: ReviewPayload) => {
    if (Array.isArray(value.items)) return value.items;
    return (value.days || []).flatMap((day, dayOffset) => (day.items || []).map((item) => ({
      ...item,
      dayIndex: item.dayIndex || day.dayIndex || dayOffset + 1,
      date: item.date || day.date,
    })));
  };
  let rawItems = flattenItems(payload);
  if (!rawItems.length) {
    result = await modelJson<ReviewPayload>(buildMessages(result), 14000);
    payload = result.route || result.reviewRoute || result;
    rawItems = flattenItems(payload);
  }
  if (!rawItems.length) throw new Error("模型没有返回可执行的复习路线，请稍后重试。");
  const timestamp = new Date().toISOString();
  const routeId = courseUid("route");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const examDate = new Date(`${input.examDate}T00:00:00`);
  const usedMinutes = new Map<number, number>();
  const items = rawItems.flatMap((item, index) => {
    const dayIndex = Math.max(1, Math.floor(Number(item.dayIndex || item.day || index + 1)));
    const inferredDate = new Date(today.getTime() + (dayIndex - 1) * 86400000);
    const candidateDate = item.date && /^\d{4}-\d{2}-\d{2}$/.test(item.date) ? new Date(`${item.date}T00:00:00`) : inferredDate;
    if (candidateDate > examDate) return [];
    const used = usedMinutes.get(dayIndex) || 0;
    const requested = Math.max(10, Number(item.estimatedMinutes || item.minutes || 30));
    const estimatedMinutes = Math.min(requested, Math.max(0, input.dailyMinutes - used));
    if (estimatedMinutes < 10) return [];
    usedMinutes.set(dayIndex, used + estimatedMinutes);
    const nodeIds = (item.nodeIds || []).filter((id) => graph.nodes.some((node) => node.id === id));
    if (!nodeIds.length) return [];
    return [{
      id: `${routeId}_item_${index + 1}`,
      routeId,
      dayIndex,
      date: candidateDate.toISOString().slice(0, 10),
      title: item.title?.trim() || `第 ${dayIndex} 天复习`,
      nodeIds,
      estimatedMinutes,
      rationale: item.rationale?.trim() || "依据课程图谱前置关系和资料重点安排。",
      status: "PENDING" as const,
    }];
  });
  if (!items.length) throw new Error("复习路线中的节点或日期无效，请调整考试范围后重试。");
  return {
    id: routeId,
    courseId,
    examDate: input.examDate,
    dailyMinutes: input.dailyMinutes,
    scope: input.scope,
    targetScore: input.targetScore,
    summary: payload.summary?.trim() || "按课程前置关系、资料重点和可用时间安排复习。",
    items,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function suggestProblemKnowledgeLinks(
  courseId: string,
  projectId: string,
  problemId: string,
  problemText: string,
  graph: CourseGraph,
): Promise<ProblemKnowledgeLink[]> {
  type RawLink = { nodeId?: string; knowledgeNodeId?: string; relevance?: number; score?: number; evidence?: string; reason?: string };
  type LinkPayload = { links?: RawLink[]; mappings?: RawLink[]; problemKnowledgeLinks?: RawLink[]; result?: LinkPayload };
  const candidateNodes = graph.nodes
    .filter((node) => !["COURSE", "CHAPTER", "EXAMPLE"].includes(node.type))
    .map((node) => ({ id: node.id, title: node.title, type: node.type, summary: node.shortSummary, conditions: node.conditions, aliases: node.aliases || [] }));
  const messages: Message[] = [
    {
      role: "system",
      content: `你负责把真实作业题关联到课程知识图谱。只选择确实用于审题、方法或关键推导的节点，不得为了数量强行关联。只允许原样复制候选节点 id。relevance 为 0-1，evidence 用一句话说明题目中的哪个条件或步骤触发了该知识点。题目显然包含课程节点时至少返回一个关联。只返回 JSON。`,
    },
    {
      role: "user",
      content: JSON.stringify({
        problemText,
        nodes: candidateNodes,
        outputShape: { links: [{ nodeId: "从 nodes 原样复制 id", relevance: 0.9, evidence: "题干或关键步骤中的直接证据" }] },
      }),
    },
  ];
  let result = await modelJson<LinkPayload>(messages, 7000, true);
  const readLinks = (payload: LinkPayload) => {
    const inner = payload.result || payload;
    return inner.links || inner.mappings || inner.problemKnowledgeLinks || [];
  };
  let rawLinks = readLinks(result);
  if (!rawLinks.length && problemText.trim()) {
    result = await modelJson<LinkPayload>([
      ...messages,
      { role: "user", content: "快速匹配返回了空数组。请用主模型重新核对题干中的概念、公式和方法；若确有对应节点，严格按 outputShape 返回。" },
    ], 7000, false);
    rawLinks = readLinks(result);
  }
  const compactProblem = problemText.replace(/\s+/g, "");
  for (const node of candidateNodes) {
    const terms = [node.title, ...node.aliases, node.title.split(/作为|的|与|（|\(/)[0]]
      .map((term) => term.replace(/\s+/g, "").trim())
      .filter((term) => term.length >= 3);
    const matched = terms.find((term) => compactProblem.includes(term));
    if (matched && !rawLinks.some((link) => (link.nodeId || link.knowledgeNodeId) === node.id)) {
      rawLinks.push({ nodeId: node.id, relevance: 0.82, evidence: `题干直接出现“${matched}”，需要核对该知识点是否参与解法。` });
    }
  }
  if (rawLinks.length) {
    const candidateDetails = rawLinks.map((link) => {
      const id = link.nodeId || link.knowledgeNodeId || "";
      return { ...link, node: candidateNodes.find((node) => node.id === id) };
    });
    const reviewed = await modelJson<LinkPayload>([
      {
        role: "system",
        content: `你是作业—知识图谱关联质检器。逐条核对候选节点的标题、定义摘要和条件是否真的用于该题。删除仅因词语相似但数学含义不同的节点；公式名称相近也必须核对定义。允许修正 relevance 和 evidence，但 nodeId 只能来自候选。只返回 JSON。`,
      },
      {
        role: "user",
        content: JSON.stringify({ problemText, candidates: candidateDetails, outputShape: { links: [{ nodeId: "候选 id", relevance: 0.8, evidence: "与题干或解法的准确关系" }] } }),
      },
    ], 7000, false);
    rawLinks = readLinks(reviewed);
  }
  const allowed = new Set(graph.nodes.map((node) => node.id));
  return rawLinks
    .map((link) => ({
      nodeId: link.nodeId || link.knowledgeNodeId || "",
      relevance: Number(link.relevance ?? link.score ?? 0),
      evidence: link.evidence || link.reason || "题目与该知识点直接相关。",
    }))
    .filter((link) => allowed.has(link.nodeId) && link.relevance >= 0.35)
    .slice(0, 12)
    .map((link, index) => ({
      id: `problem_link_${projectId}_${problemId}_${index + 1}`,
      courseId,
      projectId,
      problemId,
      nodeId: link.nodeId,
      relevance: Math.max(0, Math.min(1, Number(link.relevance))),
      evidence: link.evidence,
    }));
}
