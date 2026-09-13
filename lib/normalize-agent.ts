import type { AgentResponse, AnswerBlock, ChatMessage, KnowledgeCheckpoint, Problem, ProjectState, SolutionBlueprint } from "./agent-types";
import { repairMathText } from "./math-text";

const array = <T>(value: T[] | null | undefined): T[] => Array.isArray(value) ? value : [];

const escapedUnicodeMath: Record<string, string> = {
  "03b1": "\\alpha", "03b2": "\\beta", "03b3": "\\gamma", "03b4": "\\delta",
  "03b5": "\\varepsilon", "03b8": "\\theta", "03bb": "\\lambda", "03bc": "\\mu",
  "03c0": "\\pi", "03c1": "\\rho", "03c3": "\\sigma", "03c6": "\\phi", "03c9": "\\omega",
  "0393": "\\Gamma", "0394": "\\Delta", "0398": "\\Theta", "039b": "\\Lambda",
  "03a0": "\\Pi", "03a3": "\\Sigma", "03a6": "\\Phi", "03a9": "\\Omega",
  "2200": "\\forall", "2203": "\\exists", "2208": "\\in", "2209": "\\notin",
  "221e": "\\infty", "2260": "\\neq", "2264": "\\leq", "2265": "\\geq",
  "2282": "\\subset", "2286": "\\subseteq", "21d2": "\\Rightarrow", "21d4": "\\Leftrightarrow",
};

const blockSchema: Record<AnswerBlock["type"], { order: number; title: string }> = {
  READING: { order: 1, title: "审题与条件" },
  METHOD: { order: 2, title: "方法与依据" },
  DERIVATION: { order: 3, title: "推导与计算" },
  RESULT: { order: 4, title: "最终答案" },
  CHECK: { order: 5, title: "检验与总结" },
};

export function repairModelText(value: unknown): string {
  const objectText = (input: object): string => {
    if (Array.isArray(input)) return input.map((item) => repairModelText(item)).filter(Boolean).join("；");
    const record = input as Record<string, unknown>;
    const keys = ["text", "content", "statement", "description", "formula", "value", "result", "name"];
    const pieces: string[] = keys.filter((key) => record[key] !== undefined).map((key) => repairModelText(record[key])).filter(Boolean);
    return pieces.length ? pieces.join(" ") : JSON.stringify(input);
  };
  const text: string = typeof value === "string"
    ? value
    : value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? objectText(value)
        : String(value);
  return repairMathText(text
    .replace(/\\u([0-9a-f]{4})/gi, (match, hex: string) => escapedUnicodeMath[hex.toLowerCase()] || match)
    .replace(/\t(?=imes|ext|heta|au)/g, "\\t")
    .replace(/\f(?=rac)/g, "\\f")
    .replace(/\r(?=ight|ho)/g, "\\r")
    .replace(/\u0008(?=egin|eta|oldsymbol|ar\b|ig(?:l|r)?\b|inom|oxed)/g, "\\b")
    .replace(/\n(?=eq|abla|u(?:\b|_))/g, "\\n"));
}

function arrayMap<T>(value: Record<string, T[]> | null | undefined): Record<string, T[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, items]) => [key, array(items).filter(Boolean)]));
}

function valueMap<T>(value: Record<string, T> | null | undefined): Record<string, T> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeBlueprint(value: SolutionBlueprint | null | undefined): SolutionBlueprint | undefined {
  if (!value || typeof value !== "object") return undefined;
  return {
    qualityVersion: value.qualityVersion === "verified-v2" ? "verified-v2" : undefined,
    difficulty: ["BASIC", "INTERMEDIATE", "ADVANCED"].includes(value.difficulty) ? value.difficulty : "INTERMEDIATE",
    difficultyReason: repairModelText(value.difficultyReason),
    selectedMethod: repairModelText(value.selectedMethod),
    problemSummary: repairModelText(value.problemSummary),
    givens: array(value.givens).filter(Boolean).map(repairModelText),
    methodReason: repairModelText(value.methodReason),
    finalConclusion: repairModelText(value.finalConclusion),
    materialUsage: array(value.materialUsage).filter(Boolean).map((item) => ({
      name: repairModelText(item.name),
      applied: Boolean(item.applied),
      details: array(item.details).filter(Boolean).map(repairModelText),
      evidence: array(item.evidence).filter(Boolean).map(repairModelText),
      sourceMode: ["VISUAL_ORIGINAL", "VISUAL_INDEX", "TEXT_INDEX", "COURSE_GRAPH"].includes(item.sourceMode || "")
        ? item.sourceMode
        : undefined,
    })),
    prerequisites: array(value.prerequisites).filter(Boolean).map((item, index) => ({
      id: item.id || `prerequisite_${index + 1}`,
      name: repairModelText(item.name) || `知识点 ${index + 1}`,
      question: repairModelText(item.question),
    })),
    sections: array(value.sections).filter(Boolean).map((item, index) => ({
      id: item.id || `section_${index + 1}`,
      title: repairModelText(item.title) || `第 ${index + 1} 步`,
      goal: repairModelText(item.goal),
      explanation: repairModelText(item.explanation),
      intuition: repairModelText(item.intuition),
      keyCalculations: array(item.keyCalculations).filter(Boolean).map(repairModelText),
      commonPitfalls: array(item.commonPitfalls).filter(Boolean).map(repairModelText),
    })),
    verification: repairModelText(value.verification),
  };
}

export function normalizeProblems(value: Problem[] | null | undefined): Problem[] {
  return array(value).filter(Boolean).map((problem, position) => ({
    ...problem,
    id: problem.id || `problem_${position + 1}`,
    index: Number.isFinite(problem.index) ? problem.index : position + 1,
    title: problem.title || `第 ${position + 1} 题`,
    rawText: repairModelText(problem.rawText),
    status: problem.status || "NOT_STARTED",
    missingInformation: array(problem.missingInformation).filter(Boolean),
    sourceMaterialIds: array(problem.sourceMaterialIds).filter(Boolean),
  }));
}

function normalizeBlocks(value: AnswerBlock[] | null | undefined): AnswerBlock[] {
  const normalized = array(value).filter(Boolean).map((block, position) => {
    const type = blockSchema[block.type] ? block.type : (Object.keys(blockSchema)[Math.min(position, 4)] as AnswerBlock["type"]);
    const schema = blockSchema[type];
    const normalizedLatex = repairModelText(block.latex).trim().replace(/^\$\$?\s*/, "").replace(/\s*\$\$?$/, "");
    return {
      ...block,
      type,
      id: block.id || `answer_block_${position + 1}`,
      title: schema.title,
      order: schema.order,
      plainText: repairModelText(block.plainText),
      latex: /[\u3400-\u9fff]/u.test(normalizedLatex) ? "" : normalizedLatex,
      dependencies: array(block.dependencies).filter(Boolean),
    };
  }).filter((block) => !/自我修正|自我复核|原思考过程|修正后的输出|difficulty\s*:|sections\s*中的|keyCalculations/i.test(block.plainText));
  const byProblemAndType = new Map<string, AnswerBlock>();
  normalized.forEach((block) => {
    const key = `${block.problemId || "unknown"}:${block.type}`;
    const previous = byProblemAndType.get(key);
    byProblemAndType.set(key, previous ? { ...previous, ...block, id: previous.id } : block);
  });
  return [...byProblemAndType.values()].sort((a, b) => a.order - b.order);
}

export function normalizeAgentResponse(response: AgentResponse): AgentResponse {
  const progress = typeof response.progress === "number"
    ? Math.max(0, Math.min(100, Math.round(response.progress > 0 && response.progress <= 1 ? response.progress * 100 : response.progress)))
    : undefined;
  return {
    ...response,
    assistantMessage: response.assistantMessage === undefined ? undefined : repairModelText(response.assistantMessage),
    sideAnswer: response.sideAnswer === undefined ? undefined : repairModelText(response.sideAnswer),
    progress,
    problems: response.problems === undefined ? undefined : normalizeProblems(response.problems),
    answerBlocks: response.answerBlocks === undefined ? undefined : normalizeBlocks(response.answerBlocks),
    checkpoint: response.checkpoint
      ? { ...response.checkpoint, answerBlockIds: array(response.checkpoint.answerBlockIds).filter(Boolean) }
      : response.checkpoint,
    knowledgeCheckpoint: response.knowledgeCheckpoint
      ? { ...response.knowledgeCheckpoint, question: repairModelText(response.knowledgeCheckpoint.question) }
      : response.knowledgeCheckpoint,
    knowledgeCheckpoints: response.knowledgeCheckpoints === undefined
      ? undefined
      : array(response.knowledgeCheckpoints).filter(Boolean).map((checkpoint) => ({
          ...checkpoint,
          question: repairModelText(checkpoint.question),
        })),
    solutionBlueprint: normalizeBlueprint(response.solutionBlueprint),
    rollbackPreview: response.rollbackPreview
      ? {
          ...response.rollbackPreview,
          preservedBlockIds: array(response.rollbackPreview.preservedBlockIds).filter(Boolean),
          invalidatedBlockIds: array(response.rollbackPreview.invalidatedBlockIds).filter(Boolean),
        }
      : response.rollbackPreview,
  };
}

export function normalizeProjectState(project: ProjectState): ProjectState {
  const problems = normalizeProblems(project.problems);
  if (project.conversationVersion !== "per-problem-v1") {
    return {
      ...project,
      conversationVersion: "per-problem-v1",
      status: problems.length ? "AWAITING_CONFIRMATION" : project.status,
      currentProblemId: problems[0]?.id || null,
      teachingStage: "READING_PROBLEM",
      selectedMethod: "",
      progress: 0,
      responseMode: project.responseMode === "fast" ? "fast" : "deep",
      problems: problems.map((problem) => ({
        ...problem,
        status: problem.status === "MISSING_INFO" ? "MISSING_INFO" : "NOT_STARTED",
      })),
      materials: array(project.materials).filter(Boolean),
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
      memories: array(project.memories).filter(Boolean),
      checkpoints: [],
      rollbackPreview: null,
    };
  }
  const teachingMessages = array(project.teachingMessages).filter(Boolean).map((message) => ({ ...message, content: repairModelText(message.content) }));
  const sideMessages = array(project.sideMessages).filter(Boolean).map((message) => ({ ...message, content: repairModelText(message.content) }));
  const knowledgeCheckpoints = array(project.knowledgeCheckpoints).filter(Boolean).map((checkpoint) => ({ ...checkpoint, question: repairModelText(checkpoint.question) }));
  const currentProblemId = project.currentProblemId;
  const problemTeachingMessages = Object.fromEntries(Object.entries(arrayMap<ChatMessage>(project.problemTeachingMessages)).map(([key, messages]) => [key, messages.map((message) => ({ ...message, content: repairModelText(message.content) }))]));
  const problemSideMessages = Object.fromEntries(Object.entries(arrayMap<ChatMessage>(project.problemSideMessages)).map(([key, messages]) => [key, messages.map((message) => ({ ...message, content: repairModelText(message.content) }))]));
  const problemKnowledgeCheckpoints = Object.fromEntries(Object.entries(arrayMap<KnowledgeCheckpoint>(project.problemKnowledgeCheckpoints)).map(([key, checkpoints]) => [key, checkpoints.map((checkpoint) => ({ ...checkpoint, question: repairModelText(checkpoint.question) }))]));
  if (currentProblemId && !Object.keys(problemTeachingMessages).length && teachingMessages.length) {
    problemTeachingMessages[currentProblemId] = teachingMessages;
  }
  if (currentProblemId && !Object.keys(problemSideMessages).length && sideMessages.length) {
    problemSideMessages[currentProblemId] = sideMessages;
  }
  if (currentProblemId && !Object.keys(problemKnowledgeCheckpoints).length && knowledgeCheckpoints.length) {
    problemKnowledgeCheckpoints[currentProblemId] = knowledgeCheckpoints;
  }
  return {
    ...project,
    responseMode: project.responseMode === "fast" ? "fast" : "deep",
    problems,
    materials: array(project.materials).filter(Boolean),
    answerBlocks: normalizeBlocks(project.answerBlocks),
    teachingMessages,
    sideMessages,
    knowledgeCheckpoints,
    problemTeachingMessages,
    problemSideMessages,
    problemKnowledgeCheckpoints,
    problemTeachingStages: valueMap(project.problemTeachingStages),
    problemSelectedMethods: valueMap(project.problemSelectedMethods),
    problemProgress: valueMap(project.problemProgress),
    problemSolutionBlueprints: Object.fromEntries(
      Object.entries(valueMap(project.problemSolutionBlueprints))
        .map(([key, blueprint]) => [key, normalizeBlueprint(blueprint as SolutionBlueprint)])
        .filter((entry): entry is [string, SolutionBlueprint] => Boolean(entry[1])),
    ),
    memories: array(project.memories).filter(Boolean),
    checkpoints: array(project.checkpoints).filter(Boolean).map((checkpoint) => ({
      ...checkpoint,
      answerBlockIds: array(checkpoint.answerBlockIds).filter(Boolean),
    })),
    rollbackPreview: project.rollbackPreview
      ? {
          ...project.rollbackPreview,
          preservedBlockIds: array(project.rollbackPreview.preservedBlockIds).filter(Boolean),
          invalidatedBlockIds: array(project.rollbackPreview.invalidatedBlockIds).filter(Boolean),
        }
      : null,
  };
}
