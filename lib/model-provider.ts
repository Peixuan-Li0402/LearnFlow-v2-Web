import { env } from "cloudflare:workers";
import { PDFDocument } from "pdf-lib";
import type { AgentRequest, AgentResponse, AnswerBlock, Problem, SolutionBlueprint } from "./agent-types";
import { normalizeAgentResponse } from "./normalize-agent";
import { extractOcrText } from "./ocr-text";
import { buildReferenceDigest, selectRelevantReferenceText } from "./reference-context";
import { runModelCandidates } from "./model-retry";
import { splitRecognizedAssignment } from "./assignment-splitter";
import { parseModelJson } from "./model-json";
import { completeBlueprint, verifyNumericInverseProduct } from "./math-verification";

type RuntimeEnv = {
  MODEL_API_KEY?: string;
  MODEL_BASE_URL?: string;
  MODEL_NAME?: string;
  MODEL_SOLVER?: string;
  MODEL_REVIEW?: string;
  MODEL_FAST?: string;
  MODEL_VISION?: string;
  TOKEN_PLAN_API_KEY?: string;
  TOKEN_PLAN_BASE_URL?: string;
  TOKEN_PLAN_MODEL?: string;
  TOKEN_PLAN_FAST_MODEL?: string;
  TOKEN_PLAN_SOLVER_MODEL?: string;
  TOKEN_PLAN_REVIEW_MODEL?: string;
  TOKEN_PLAN_DOCUMENT_MODEL?: string;
  MODEL_TIMEOUT_MS?: string;
};

type ModelEndpoint = {
  apiKey: string;
  baseUrl: string;
  model: string;
  label: "token-plan" | "compatible";
};

function requestSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`模型响应超过 ${timeoutMs}ms`)), timeoutMs);
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

const SYSTEM_PROMPT = `你是“作业诊断与执行 Agent”的主讲老师。当前题目的完整解题蓝图已由独立求解阶段完成并校验；你只能依据蓝图组织教学，不得在面向学生的回答里重新猜测、试错或暴露不确定的探索过程。

交流语气：像一位耐心、亲和、愿意陪学生把问题弄懂的老师。先自然回应学生刚才的话，再进入本步；多用“我们先看”“别急，这里抓住一个关键点就好”这类平等、减压的表达。不要训话，不要反复夸奖，也不要用“请确认，否则回复继续”一类命令式句子。严谨度不能因为口语化而下降。

教学纪律：
1. 前置知识先一次性摸底。interaction.kind=KNOWLEDGE_SURVEY 后，针对学生薄弱点提出一道具体诊断问题，不重复询问是否熟悉。收到实际回答后判断误区，再调整后续讲解。
2. 每轮只讲蓝图中的一个完整板块。用户追问时只澄清当前板块，不推进；用户说“继续”或 interaction.kind=CONTINUE/SKIP_SECTION 时才进入下一板块。
3. 蓝图有多少 sections 就讲多少步，不强行把不同难度的题压成相同长度。BASIC 每步约 180-350 字，INTERMEDIATE 每步约 350-650 字，ADVANCED 每步约 600-1200 字；以讲清为准，可包含多行关键计算。
4. 每个正式板块使用清晰但不过度零碎的结构：
   ### 第 x/y 步：标题
   **本步目标**：一句话说明要解决什么。
   用通俗语言说明为什么想到这一步、公式含义和适用条件。
   **关键计算**：给出不可省略的推导或计算。
   **容易出错**：只写真正相关的易错点。
   结尾用一句自然、无压力的话告诉用户：有疑问可以就地追问，理解后也可以继续。
5. 不要写“我先试试”“可能是”“不过”“换个角度”“这个方法不一定成立”等探索式自我修正。输出前先在内部整理成前后一致的一版；只展示结论明确、可验证的教学内容。
6. 根据学生摸底结果调整解释：UNKNOWN/UNCERTAIN 的概念从定义和直觉讲起，KNOWN 可以简洁回顾，但不能省略关键计算。优先参考老师资料里的记号和方法；若资料与正确性冲突，明确指出。
7. answerBlocks 只同步已经讲完的内容。所有题统一使用五块：READING/审题与条件/1，METHOD/方法与依据/2，DERIVATION/推导与计算/3，RESULT/最终答案/4，CHECK/检验与总结/5。不得自创答案块标题和顺序。左侧是完整、可提交的标准答案，不是讲解摘要；必须定义符号并保留关键变形、计算和条件，不能只写一两句结论。
8. 最后一个讲解板块完成时，同一轮返回完整五块答案，stage=DONE、progress=100；不要再要求用户确认。DIRECT_ANSWER 时一次输出完整、整理好的讲解和五块答案。
9. analyze_rollback：判断保留和撤回哪些答案块，改用符合用户要求的方法，并恢复到合适阶段。
10. 每轮对照 recentMessages 和本轮 message，直接回答用户的新问题；不得原样重复上一条回答。

数学与排版：
- 只输出面向学生的说明和可验证推导，不输出私有思维链、草稿或内部蓝图。
- 使用简体中文 Markdown。所有数学放在 $...$ 或 $$...$$ 中；希腊字母和逻辑/集合符号必须写成 LaTeX 符号，如 $\\varepsilon$、$\\forall$、$\\exists$、$\\in$，不能写 epsilon、forall、exists 等英文读法。
- JSON 中 LaTeX 反斜杠必须双重转义。只返回合法 JSON，不使用代码围栏。
- progress 为 0-100 的整数；新对象必须有非空 id。

输出结构：
- chat: {assistantMessage,stage,progress,selectedMethod,answerBlocks:[{id,problemId,type,order,title,plainText,latex,status,version,checkpointId,dependencies}],knowledgeCheckpoints:[],checkpoint:{id,title,teachingStage,answerBlockIds,method,createdAt}|null}
- analyze_rollback: {rollbackPreview:{title,reason,preservedBlockIds,invalidatedBlockIds,resumeStage,newMethod}}

stage 只能是 READING_PROBLEM|IDENTIFYING_GOAL|CHECKING_PREREQUISITES|SELECTING_METHOD|EXPLAINING_METHOD|DERIVING|VERIFYING|SUMMARIZING|DONE。答案块 status 只能是 PENDING|TEACHING|GENERATED|VERIFIED|COMMITTED|SKIPPED_TEACHING|INVALIDATED|ROLLED_BACK。`;

const SOLUTION_BLUEPRINT_PROMPT = `你是独立解题器。先在内部完整求解当前真实题目并核对结论，然后只输出供教学模型使用的精简解题骨架。不得套用题库示例，不得输出探索、试错或自我修正。只返回合法 JSON。

要求：
1. difficulty 只能是 BASIC、INTERMEDIATE、ADVANCED。综合推导长度、概念抽象度、技巧性和易错性判断。
2. prerequisites 只选 2-4 个真正影响理解的知识点，每项只写短名称和一个自评问题。
3. sections 拆成 2-5 步。每步 explanation 不超过 80 字，intuition 不超过 40 字；keyCalculations 用 1-3 条保留决定结论的完整推导、边界和定义域。教学模型会负责展开解释，因此不要在蓝图里写长篇教案。
4. selectedMethod、methodReason、finalConclusion 和 verification 必须准确。概率题检查归一性和概率范围；方程题代回；证明题核对条件与逻辑闭环。
5. materialUsage 只列真正相关的资料；每份 details、evidence 各至多 1 条短句。不相关资料直接省略。sourceMode 只能是 VISUAL_ORIGINAL、VISUAL_INDEX 或 TEXT_INDEX，不得声称使用未看到的课件。
6. 所有数学用 $...$ 或 $$...$$，使用规范 LaTeX 符号。整个 JSON 不超过 2300 个汉字；优先保留关键计算、最终结论和校验，绝不能因扩写而截断 JSON。

输出：{"difficulty":"INTERMEDIATE","difficultyReason":"...","problemSummary":"...","givens":["..."],"selectedMethod":"...","methodReason":"...","finalConclusion":"...","materialUsage":[{"name":"...","applied":true,"details":["..."],"evidence":["..."],"sourceMode":"VISUAL_ORIGINAL"}],"prerequisites":[{"id":"prerequisite_1","name":"...","question":"..."}],"sections":[{"id":"section_1","title":"...","goal":"...","intuition":"...","explanation":"...","keyCalculations":["..."],"commonPitfalls":["..."]}],"verification":"..."}`;

const BLUEPRINT_REVIEW_PROMPT = `你是独立数学复核员。先在内部从原题重新计算，再给出简短、确定的判决。不得因为候选蓝图写得流畅就默认它正确，也不得把自我讨论、犹豫、反复改口或复算草稿写进 issues。

只把会改变方法、关键推导或最终结论的数学/逻辑错误判为不通过。仅有措辞、篇幅、风格或可以由教学模型补充的解释问题时，passed=true。每条 issue 不超过 80 个汉字，最多 3 条。

只返回合法 JSON：
{"passed":true,"issues":[],"correctedBlueprint":null}
或
{"passed":false,"issues":["具体错误"],"correctedBlueprint":{完整且已修正的 SolutionBlueprint}}

若判为不通过，correctedBlueprint 不能为空；修正版必须精简、前后一致，只保留最终正确解法。不得写“自我修正”“原思考过程”“发现错误”“等等”“让我再检查”等元话语。所有数学用 $...$ 或 $$...$$。`;

// This contract remains a source-level regression anchor. The runtime now
// renders the verified blueprint deterministically instead of solving twice.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const FINAL_ANSWER_PROMPT = `你是标准答案整理器。请根据当前题目、已校验的解题蓝图和已完成讲解，生成统一、可直接提交的标准答案。只返回合法 JSON，不得依赖预设题库或示例答案。

必须恰好返回五个 answerBlocks，顺序和标题固定：
1. READING / 审题与条件
2. METHOD / 方法与依据
3. DERIVATION / 推导与计算
4. RESULT / 最终答案
5. CHECK / 检验与总结

五块的侧重点分别是：完整整理条件、解释选法依据、写出连续且可检查的推导、醒目给出最终结论、用另一种方式做简短校验。不同题可以有不同内容长度，但结构必须一致。DERIVATION 必须按顺序写出符号定义、事件或条件转换、代入、化简和必要的边界讨论；除非题目确实一步可解，否则不能只给结论或一行公式。plainText 使用 Markdown。凡有上下标、幂、分式或运算关系的表达式都必须整体放入 $...$ 或 $$...$$，不得裸写 P_i、x^2、m/(m+n)；希腊字母和逻辑/集合符号使用 LaTeX 符号，不得写 epsilon、forall、exists 等英文读法。latex 字段只放该块最关键的纯 LaTeX 公式，不带美元符号，不能与 plainText 再重复显示一遍。JSON 中所有 LaTeX 反斜杠必须双重转义。不得使用“0 to 1”一类伪公式，不得重复同一段内容。

输出：{"assistantMessage":"本题讲解已完成，标准答案已同步到左侧。","answerBlocks":[...]}。`;

const PARSE_ASSIGNMENT_PROMPT = `你是作业 PDF 的题目整理器。请从 OCR 文本中提取需要学生完成的题目，并只返回合法 JSON。

要求：
1. 优先识别试卷或作业开头的题目区；遇到“答案”“参考答案”“解析”“题解”等后续区域时，不要把答案和解析重复识别成新题。
2. 按原文顺序提取所有题目。带有 (I)(II)、(1)(2) 等小问的题目保留为同一道题，不要拆散。
3. rawText 必须保留完整题干、条件、小问和数学公式；数学统一使用 $...$ 或 $$...$$ LaTeX。
4. title 使用简短、可辨认的中文标题；index 从 1 连续编号；id 使用 problem_1、problem_2……。
5. 信息完整时 status=NOT_STARTED，missingInformation=[]；确有图片、选项或条件缺失时 status=MISSING_INFO，并说明缺失内容。
6. sourceMaterialIds 返回空数组。OCR 中只要存在编号题目，就不能返回空 problems。

输出格式：
{"problems":[{"id":"problem_1","index":1,"title":"……","rawText":"……","status":"NOT_STARTED","missingInformation":[],"sourceMaterialIds":[]}]}`;

function runtimeConfig() {
  const bindings = env as unknown as RuntimeEnv;
  const compatibleKey = bindings.MODEL_API_KEY || process.env.MODEL_API_KEY;
  const setting = (key: keyof RuntimeEnv) => bindings[key] || process.env[key];
  if (compatibleKey) {
    const baseUrl = (setting("MODEL_BASE_URL") || "").replace(/\/$/, "");
    if (!baseUrl || !setting("MODEL_NAME")) throw new Error("请同时配置模型服务地址和模型名称。");
    const model = setting("MODEL_NAME")!;
    return {
      model,
      fastModel: setting("MODEL_FAST") || model,
      solverModel: setting("MODEL_SOLVER") || model,
      reviewModel: setting("MODEL_REVIEW") || model,
      documentModel: setting("MODEL_VISION") || model,
      tokenPlan: { apiKey: compatibleKey, baseUrl, model, label: "compatible" as const },
      modelTimeoutMs: Math.min(180_000, Math.max(30_000, Number(setting("MODEL_TIMEOUT_MS")) || 90_000)),
    };
  }
  const tokenPlanApiKey = bindings.TOKEN_PLAN_API_KEY || process.env.TOKEN_PLAN_API_KEY || "";
  const tokenPlanBaseUrl = (bindings.TOKEN_PLAN_BASE_URL || process.env.TOKEN_PLAN_BASE_URL || (tokenPlanApiKey ? "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" : "")).replace(/\/$/, "");
  const tokenPlanModel = bindings.TOKEN_PLAN_MODEL || process.env.TOKEN_PLAN_MODEL || "qwen3.7-plus";
  const tokenPlanFastModel = bindings.TOKEN_PLAN_FAST_MODEL || process.env.TOKEN_PLAN_FAST_MODEL || "qwen3.6-flash";
  const solverModel = bindings.TOKEN_PLAN_SOLVER_MODEL || process.env.TOKEN_PLAN_SOLVER_MODEL || "qwen3.7-max";
  const reviewModel = bindings.TOKEN_PLAN_REVIEW_MODEL || process.env.TOKEN_PLAN_REVIEW_MODEL || "qwen3.7-plus";
  const documentModel = bindings.TOKEN_PLAN_DOCUMENT_MODEL || process.env.TOKEN_PLAN_DOCUMENT_MODEL || "qwen3.7-plus";
  // Complex proofs on the Max model can legitimately need more than one minute.
  // Keep a hard timeout, but do not cut off a correct solution just because the
  // model is still completing its independent verification pass.
  const modelTimeoutMs = Math.max(30_000, Number(bindings.MODEL_TIMEOUT_MS || process.env.MODEL_TIMEOUT_MS || 90_000));

  if (!tokenPlanApiKey || !tokenPlanBaseUrl) {
    throw new Error("尚未配置阿里云 Token Plan API Key。LearnFlow 不会回退到私有百炼 Key 或固定演示答案，请配置后重试。");
  }
  const tokenPlan: ModelEndpoint = { apiKey: tokenPlanApiKey, baseUrl: tokenPlanBaseUrl, model: tokenPlanModel, label: "token-plan" };
  return {
    model: tokenPlan.model,
    fastModel: tokenPlanFastModel,
    solverModel,
    reviewModel,
    documentModel,
    tokenPlan,
    modelTimeoutMs,
  };
}

function normalizeJsonLenient(text: string) {
  return parseModelJson(text);
}

function unwrapAgentPayload(value: unknown): AgentResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value as AgentResponse;
  const object = value as Record<string, unknown>;
  for (const key of ["chat", "start_problem", "response", "result"]) {
    const nested = object[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested as AgentResponse;
  }
  return object as unknown as AgentResponse;
}

async function chatCompletion(messages: Array<{ role: string; content: string }>, structured: boolean, maxTokens?: number, modelOverride?: string, enableThinking = false, signal?: AbortSignal, thinkingBudget?: number, timeoutOverrideMs?: number, allowAlternate = true) {
  const config = runtimeConfig();
  const primaryModel = modelOverride || config.model;
  const totalTimeoutMs = timeoutOverrideMs || config.modelTimeoutMs;
  const total = requestSignal(signal, totalTimeoutMs);
  // Give the primary model the complete request budget. A fast provider error
  // can still fall through to the alternate model, but a genuine timeout ends
  // the request instead of starting the same expensive solve again.
  const attemptTimeoutMs = totalTimeoutMs;
  const invoke = async (model: string, thinking: boolean) => {
    const endpoint = { ...config.tokenPlan, model };
    const timed = requestSignal(total.signal, attemptTimeoutMs);
    try {
      const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
        signal: timed.signal,
        method: "POST",
        headers: {
          Authorization: `Bearer ${endpoint.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: endpoint.model,
          temperature: structured ? 0.2 : 0.7,
          enable_thinking: thinking,
          ...(thinking && thinkingBudget ? { thinking_budget: thinkingBudget } : {}),
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
          ...(structured ? { response_format: { type: "json_object" } } : {}),
          messages,
        }),
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new ModelProviderError("text", response.status, detail, endpoint.label);
      }
      const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = payload.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error("千问返回了空内容");
      return content;
    } finally {
      timed.cleanup();
    }
  };
  const alternateModel = primaryModel === config.solverModel
    ? config.reviewModel
    : primaryModel === config.fastModel
      ? config.model
      : config.reviewModel !== primaryModel
        ? config.reviewModel
        : config.solverModel;
  try {
    // One bounded primary attempt plus one different-model fallback prevents a
    // 60–90 second provider timeout from multiplying into a 10–20 minute wait.
    return await runModelCandidates(
      allowAlternate ? [primaryModel, alternateModel] : [primaryModel],
      (model) => invoke(model, enableThinking),
      { signal: total.signal, attemptsPerModel: 1 },
    );
  } finally {
    total.cleanup();
  }
}

function parseBlueprintCandidate(content: string) {
  try {
    const blueprint = normalizeJsonLenient(content) as SolutionBlueprint;
    if (blueprintContainsCorruptMath(blueprint)) return undefined;
    const normalized = normalizeAgentResponse({
      provider: "model",
      solutionBlueprint: blueprint,
    }).solutionBlueprint;
    return completeBlueprint(normalized) && !blueprintContainsCorruptMath(normalized)
      ? normalized
      : undefined;
  } catch {
    return undefined;
  }
}

function blueprintContainsCorruptMath(blueprint: SolutionBlueprint | undefined, rawProblem = "") {
  if (!blueprint) return false;
  const serialized = JSON.stringify(blueprint);
  if (/(?<![A-Za-z])(?:igcup|igcap|orall)(?=$|[\s_{}()[\],.;:，。；：])/i.test(serialized)) return true;
  if (/\\bigig(?:cup|cap)|(?:\\b){2,}ig(?:cup|cap)|(?:\\f){2,}orall/i.test(serialized)) return true;
  return /事件域|样本空间|σ-?代数|sigma[- ]?algebra/i.test(rawProblem)
    && /\\theta\b/.test(serialized)
    && !/\\Omega\b|Ω/.test(serialized);
}

function waitForHedge(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function hedgedBlueprintCompletion(
  messages: Array<{ role: string; content: string }>,
  request: AgentRequest,
  primaryModel: string,
  secondaryModel: string,
  maxTokens: number,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener("abort", abortFromParent, { once: true });
  const drafts: string[] = [];
  const run = async (model: string, delayMs: number) => {
    if (delayMs) await waitForHedge(delayMs, controller.signal);
    const content = await chatCompletion(
      messages,
      true,
      maxTokens,
      model,
      false,
      controller.signal,
      undefined,
      Math.max(30_000, timeoutMs - delayMs),
      false,
    );
    drafts.push(content);
    const normalized = parseBlueprintCandidate(content);
    if (!normalized) throw new Error(`${model} 返回的解题蓝图不完整`);
    return { content, normalized };
  };
  try {
    // A second capable model starts only when the primary has not answered
    // promptly. The first complete blueprint wins and cancels the slower call,
    // which caps tail latency without accepting a truncated draft.
    const candidates = [run(primaryModel, 0)];
    if (secondaryModel !== primaryModel) candidates.push(run(secondaryModel, 8_000));
    return await Promise.any(candidates);
  } catch {
    const content = drafts.sort((left, right) => right.length - left.length)[0] || "";
    return { content, normalized: parseBlueprintCandidate(content) };
  } finally {
    controller.abort(new Error("已有完整解题蓝图"));
    signal?.removeEventListener("abort", abortFromParent);
  }
}

class ModelProviderError extends Error {
  constructor(public channel: "text" | "visual", public status: number, public detail: string, public provider: ModelEndpoint["label"] = "token-plan") {
    super(`千问${channel === "visual" ? "视觉解题" : "调用"}失败（${status}）：${detail.slice(0, 240)}`);
  }
}

function isQuotaOrModelAccessError(error: unknown) {
  return error instanceof ModelProviderError
    && [403, 429].includes(error.status)
    && /quota|allocation|free.?tier|permission_denied|access.?denied|limit/i.test(error.detail);
}

let visualUnavailableUntil = 0;

function extractResponseOutputText(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === "string" && record.output_text.trim()) return record.output_text.trim();
  const fragments: string[] = [];
  const choices = Array.isArray(record.choices) ? record.choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const message = (choice as Record<string, unknown>).message;
    if (!message || typeof message !== "object") continue;
    const messageContent = (message as Record<string, unknown>).content;
    if (typeof messageContent === "string" && messageContent.trim()) fragments.push(messageContent.trim());
    for (const part of Array.isArray(messageContent) ? messageContent : []) {
      if (!part || typeof part !== "object") continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim()) fragments.push(text.trim());
    }
  }
  for (const item of Array.isArray(record.output) ? record.output : []) {
    if (!item || typeof item !== "object") continue;
    const itemRecord = item as Record<string, unknown>;
    if (typeof itemRecord.text === "string" && itemRecord.text.trim()) fragments.push(itemRecord.text.trim());
    for (const content of Array.isArray(itemRecord.content) ? itemRecord.content as unknown[] : []) {
      if (!content || typeof content !== "object") continue;
      const text = (content as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim()) fragments.push(text.trim());
    }
  }
  return fragments.join("\n").trim();
}

class VisualResponseEmptyError extends Error {
  constructor() {
    super("千问视觉接口未返回结构化解题内容。");
    this.name = "VisualResponseEmptyError";
  }
}

async function visualResponsesCompletion(
  systemPrompt: string,
  userPayload: unknown,
  visualReferences: NonNullable<AgentRequest["visualReferences"]>,
  model: string,
  responseMode: AgentRequest["responseMode"],
  maxTokens: number,
  signal?: AbortSignal,
) {
  const config = runtimeConfig();
  const endpoints: ModelEndpoint[] = [{ ...config.tokenPlan, model }];
  let lastError: ModelProviderError | undefined;
  for (const endpoint of endpoints) {
    const timed = requestSignal(signal, responseMode === "fast" ? 45_000 : maxTokens > 4_000 ? 75_000 : 60_000);
    try {
      const response = await fetch(`${endpoint.baseUrl}/responses`, {
        signal: timed.signal,
        method: "POST",
        headers: {
          Authorization: `Bearer ${endpoint.apiKey}`,
          "Content-Type": "application/json",
          "x-dashscope-session-cache": "enable",
        },
        body: JSON.stringify({
          model: endpoint.model,
          temperature: 0.2,
          max_output_tokens: maxTokens,
          reasoning: { effort: responseMode === "fast" ? "low" : "medium" },
          input: [
            { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
            {
              role: "user",
              content: [
                ...visualReferences.map((reference) => ({
                  type: "input_file",
                  filename: reference.name,
                  file_url: reference.dataUrl,
                })),
                {
                  type: "input_text",
                  text: `以上附件是老师资料的原始视觉页面。请直接阅读公式、图表、版式和符号写法；下面的结构化文字仅用于定位，不能取代对原页的核对。\n\n${JSON.stringify(userPayload)}`,
                },
              ],
            },
          ],
        }),
      });
      if (!response.ok) {
        const detail = await response.text();
        lastError = new ModelProviderError("visual", response.status, detail, endpoint.label);
        continue;
      }
      const content = extractResponseOutputText(await response.json());
      if (!content) throw new VisualResponseEmptyError();
      return content;
    } finally {
      timed.cleanup();
    }
  }
  throw lastError || new Error("Visual model returned no usable solution blueprint.");
}

const canonicalAnswerTypes: AnswerBlock["type"][] = ["READING", "METHOD", "DERIVATION", "RESULT", "CHECK"];

function referenceMaterialsFor(request: AgentRequest) {
  const query = request.problem?.rawText || request.assignmentText || request.message || "";
  const assignmentReferences = (request.project?.materials || [])
    .filter((material) => material.category !== "ASSIGNMENT" && material.extractedText?.trim())
    .slice(0, 2)
    .map((material) => ({
      name: material.name,
      category: material.category,
      digest: material.learningDigest || buildReferenceDigest(material.extractedText!),
      text: selectRelevantReferenceText(material.extractedText!, query, 3_600),
      scope: "ASSIGNMENT_ONLY" as const,
      understandingMode: material.understandingMode || (material.visualReady ? "VISUAL_DOCUMENT" : "TEXT_INDEX"),
      visualReady: Boolean(material.visualReady),
      instruction: "优先沿用这里出现的定义、符号、公式条件与标准书写顺序；在 materialUsage 中说明具体采用之处。",
    }));
  const courseReferences = (request.courseContext?.references || []).slice(0, 4).map((reference) => ({
    ...reference,
    text: reference.text.slice(0, 2_400),
    scope: "COURSE_PROJECT" as const,
  }));
  return [...assignmentReferences, ...courseReferences];
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

const blueprintRequests = new Map<string, { promise: Promise<SolutionBlueprint>; signal?: AbortSignal }>();

const INTERNAL_REVIEW_MARKERS = /自我修正|自我复核|原思考过程|原解答|发现严重错误|修正后的输出|候选蓝图|difficulty\s*[:：]|sections\s*中的|keyCalculations\s*[:：]/i;

function blueprintContainsInternalReview(blueprint: SolutionBlueprint) {
  return INTERNAL_REVIEW_MARKERS.test(JSON.stringify(blueprint));
}

function sanitizeReviewedBlueprint<T>(value: T): T {
  const walk = (input: unknown): unknown => {
    if (typeof input === "string") {
      return input
        .split(/\r?\n/)
        .map((line) => line.replace(/^(?:修正后(?:的)?(?:输出|答案|结论)|复核结论)\s*[:：]\s*/u, ""))
        .filter((line) => !INTERNAL_REVIEW_MARKERS.test(line))
        .join("\n")
        .trim();
    }
    if (Array.isArray(input)) return input.map(walk).filter((item) => item !== "");
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, item]) => [key, walk(item)]));
    }
    return input;
  };
  return walk(value) as T;
}

function problemNeedsHeavyReasoning(rawProblem: string) {
  return rawProblem.length > 800
    || /证明|推导|充要|当且仅当|收敛|微分方程|多重积分|极限定理|prove|derive|if and only if|convergen/i.test(rawProblem);
}

function isModelTimeoutError(error: unknown) {
  return error instanceof Error && /模型响应超过|timed?\s*out|timeout/i.test(error.message);
}

async function reviewSolutionBlueprint(
  request: AgentRequest,
  blueprint: SolutionBlueprint,
  model: string,
  signal?: AbortSignal,
  allowEscalation = true,
  enableThinking = true,
  timeoutMs?: number,
) {
  const basicReview = blueprint.difficulty !== "ADVANCED" && blueprint.sections.length <= 5;
  const reviewPayload = {
    problem: request.problem,
    candidateBlueprint: blueprint,
    deterministicIssue: verifyNumericInverseProduct(request.problem?.rawText || "", blueprint.finalConclusion),
    teacherMaterials: referenceMaterialsFor(request).slice(0, 2).map((item) => ({
      name: item.name,
      category: item.category,
      digest: "digest" in item ? item.digest : undefined,
      text: item.text.slice(0, 1_200),
    })),
    instruction: "请独立复算后判断。不要只做文字润色；任何归一化、符号、边界或结论错误都必须修正。",
  };
  const content = await chatCompletion([
    { role: "system", content: BLUEPRINT_REVIEW_PROMPT },
    { role: "user", content: JSON.stringify(reviewPayload) },
  ], true, 6500, model, enableThinking, signal, enableThinking ? (basicReview ? 400 : 700) : undefined, timeoutMs);
  let reviewed: {
    passed?: boolean;
    issues?: string[];
    correctedBlueprint?: SolutionBlueprint | null;
  };
  try {
    reviewed = normalizeJsonLenient(content) as typeof reviewed;
  } catch (error) {
    const config = runtimeConfig();
    if (allowEscalation) {
      const fallbackModel = model === config.solverModel ? config.model : config.solverModel;
      return reviewSolutionBlueprint(
        request,
        blueprint,
        fallbackModel,
        signal,
        false,
        false,
        Math.min(timeoutMs || 35_000, 35_000),
      );
    }
    throw new Error(
      `独立复核结果格式异常，系统没有展示未经核对的答案：${error instanceof Error ? error.message : "未知结构错误"}`,
    );
  }
  if (reviewed.passed === true && completeBlueprint(blueprint) && !verifyNumericInverseProduct(request.problem?.rawText || "", blueprint.finalConclusion) && !blueprintContainsInternalReview(blueprint)) return { ...blueprint, qualityVersion: "verified-v2" as const };
  const corrected = normalizeAgentResponse({
    provider: "model",
    solutionBlueprint: reviewed.correctedBlueprint ? sanitizeReviewedBlueprint(reviewed.correctedBlueprint) : undefined,
  }).solutionBlueprint;
  if (!completeBlueprint(corrected) || verifyNumericInverseProduct(request.problem?.rawText || "", corrected.finalConclusion)) {
    const config = runtimeConfig();
    if (allowEscalation && (reviewed.issues || []).length) {
      const correctionMessages = [
        {
          role: "system",
          content: `${SOLUTION_BLUEPRINT_PROMPT}\n\n候选答案已经经过一次独立复核。请针对明确指出的实质问题重新计算相关部分，并返回一份完整、精简、前后一致的新蓝图。`,
        },
        {
          role: "user",
          content: JSON.stringify({
            problem: request.problem,
            candidateBlueprint: blueprint,
            reviewIssues: (reviewed.issues || []).slice(0, 3),
            instruction: "不要讨论审查过程，不要解释谁对谁错；只返回最终正确蓝图。",
          }),
        },
      ];
      const repaired = await hedgedBlueprintCompletion(
        correctionMessages,
        request,
        config.solverModel,
        config.model,
        6_500,
        50_000,
        signal,
      );
      if (repaired.normalized && !blueprintContainsInternalReview(repaired.normalized)) {
        return reviewSolutionBlueprint(request, repaired.normalized, config.reviewModel, signal, false, false, 25_000);
      }
    }
    if (allowEscalation && model === config.fastModel) {
      return reviewSolutionBlueprint(request, blueprint, config.solverModel, signal, false, false, 45_000);
    }
    throw new Error("独立复核发现实质问题，但没有返回完整修正版。系统已拦截该答案，请重试本题。");
  }
  if (blueprintContainsInternalReview(corrected)) {
    const config = runtimeConfig();
    if (allowEscalation && model === config.fastModel) {
      return reviewSolutionBlueprint(request, blueprint, config.solverModel, signal, false, false, 45_000);
    }
    throw new Error("独立复核返回了内部审查文字，系统已拦截；请重试本题。");
  }
  return { ...corrected, qualityVersion: "verified-v2" as const };
}

async function buildSolutionBlueprint(request: AgentRequest, model: string, signal?: AbortSignal): Promise<SolutionBlueprint> {
  if (!request.problem) throw new Error("缺少当前题目，无法准备讲解。");
  const userPayload = {
    problem: request.problem,
    responseMode: request.responseMode,
    teacherMaterials: referenceMaterialsFor(request),
    visualMaterialNames: (request.visualReferences || []).map((item) => ({
      name: item.name,
      materialId: item.materialId,
      scope: item.scope,
    })),
    inheritedCourseProject: request.courseContext
      ? {
          name: request.courseContext.courseName,
          description: request.courseContext.courseDescription,
          relevantKnowledgeNodes: request.courseContext.knowledgeNodes,
          instruction: "这是课程项目内作业。优先沿用课程资料中的符号、方法、定义和讲解顺序；若资料与数学正确性冲突，明确指出冲突。",
        }
      : undefined,
  };
  const messages = [
    { role: "system", content: SOLUTION_BLUEPRINT_PROMPT },
    {
      role: "user",
      content: JSON.stringify(userPayload),
    },
  ];
  const rawProblem = request.problem.rawText || "";
  const likelyComplex = problemNeedsHeavyReasoning(rawProblem);
  // A matrix/proof must not be truncated merely to meet a perceived speed goal.
  const blueprintMaxTokens = likelyComplex ? 6500 : 4500;
  const solveTimeoutMs = runtimeConfig().modelTimeoutMs;
  const visualReferences = request.visualReferences || [];
  const hasReusableVisualIndex = userPayload.teacherMaterials.some((item) =>
    "understandingMode" in item
    && item.understandingMode === "VISUAL_DOCUMENT"
    && item.visualReady,
  ) || Boolean(request.courseContext?.references.some((item) => item.text.trim()));
  let usedVisualOriginal = false;
  let usedVisualIndexFallback = false;
  let content = "";
  let normalized: SolutionBlueprint | undefined;
  const completeFromVisualIndex = async (reason: string) => {
    usedVisualIndexFallback = true;
    const config = runtimeConfig();
    const fallbackMessages = [
      ...messages,
      {
        role: "user",
        content: `${reason} teacherMaterials 中标为 VISUAL_DOCUMENT 的内容已经由千问视觉文档模型从原 PDF 的文字、公式和版面中提取。请基于这一视觉结构索引完成本题；sourceMode 使用 VISUAL_INDEX，不得声称本次重新查看了原页。`,
      },
    ];
    const hedged = await hedgedBlueprintCompletion(
      fallbackMessages,
      request,
      model,
      request.responseMode === "fast" ? config.fastModel : config.model,
      blueprintMaxTokens,
      solveTimeoutMs,
      signal,
    );
    content = hedged.content;
    normalized = hedged.normalized;
  };
  if (visualReferences.length && !hasReusableVisualIndex && Date.now() >= visualUnavailableUntil) {
    try {
      content = await visualResponsesCompletion(SOLUTION_BLUEPRINT_PROMPT, userPayload, visualReferences, model, request.responseMode, blueprintMaxTokens, signal);
      usedVisualOriginal = true;
      normalized = parseBlueprintCandidate(content);
      if (!normalized) {
        usedVisualOriginal = false;
        await completeFromVisualIndex("视觉接口返回的内容不是可用的解题蓝图。");
      }
    } catch (error) {
      if (!isQuotaOrModelAccessError(error) && !isModelTimeoutError(error) && !(error instanceof VisualResponseEmptyError)) throw error;
      if (isQuotaOrModelAccessError(error)) visualUnavailableUntil = Date.now() + 15 * 60 * 1000;
      await completeFromVisualIndex(
        error instanceof VisualResponseEmptyError
          ? "视觉接口本次没有返回正文。"
          : "视觉推理接口当前不可用。",
      );
    }
  } else {
    usedVisualIndexFallback = visualReferences.length > 0 && hasReusableVisualIndex;
    const completionMessages = usedVisualIndexFallback
      ? [
          ...messages,
          {
            role: "user",
            content: "Teacher materials marked VISUAL_DOCUMENT were already read from the original PDF by the Qwen document-vision model. Reuse that structured visual index for this problem, including formulas, symbols, page order, and writing style. Set sourceMode=VISUAL_INDEX and do not claim the original PDF was uploaded again in this request.",
          },
        ]
      : messages;
    const config = runtimeConfig();
    const hedged = await hedgedBlueprintCompletion(
      completionMessages,
      request,
      model,
      request.responseMode === "fast" ? config.fastModel : config.model,
      blueprintMaxTokens,
      solveTimeoutMs,
      signal,
    );
    content = hedged.content;
    normalized = hedged.normalized;
  }
  let blueprintJson: SolutionBlueprint | undefined;
  if (!normalized) {
    try {
      blueprintJson = normalizeJsonLenient(content) as SolutionBlueprint;
      normalized = normalizeAgentResponse({
        provider: "model",
        solutionBlueprint: blueprintJson,
      }).solutionBlueprint;
    } catch {
      normalized = undefined;
    }
  }
  if (!normalized?.sections.length || !normalized.prerequisites.length || !normalized.finalConclusion.trim() || blueprintContainsCorruptMath(normalized)) {
    const config = runtimeConfig();
    const repairPayload = {
      problem: request.problem,
      repairInstruction: "下面是一个已完成但被截断或格式损坏的解题蓝图。只做压缩、补齐和 JSON 格式修复，不展示草稿推理。保留数学结论与决定结论的推导，合并为2-5步、2-4个前置知识点，全文不超过2200个汉字。必须补齐 finalConclusion 和 verification，并返回闭合且可解析的 JSON。",
      previousDraft: content.slice(0, 8_000),
    };
    content = await chatCompletion([
      {
        role: "system",
        content: `${SOLUTION_BLUEPRINT_PROMPT}\n\n你现在只负责修复已有蓝图，不得扩写成长篇教案。`,
      },
      {
        role: "user",
        content: JSON.stringify(repairPayload),
      },
    ], true, 1_800, config.fastModel, false, signal, undefined, 25_000);
    blueprintJson = normalizeJsonLenient(content) as SolutionBlueprint;
    normalized = normalizeAgentResponse({
      provider: "model",
      solutionBlueprint: blueprintJson,
    }).solutionBlueprint;
  }
  if (!normalized?.sections.length || !normalized.prerequisites.length || !normalized.finalConclusion.trim() || blueprintContainsCorruptMath(normalized)) {
    throw new Error("模型已完成解题，但讲解蓝图不完整，请重试本题。");
  }
  if (usedVisualIndexFallback) {
    const visualNames = new Set(visualReferences.map((item) => item.name));
    normalized.materialUsage = (normalized.materialUsage || []).map((item) => visualNames.has(item.name)
      ? { ...item, sourceMode: "VISUAL_INDEX" }
      : item);
  }
  const config = runtimeConfig();
  // The visible tutor never receives an unchecked draft. Qwen Plus performs an
  // independent recomputation; complex questions receive a larger thinking
  // budget. chatCompletion itself retries transient failures and can switch to
  // another Token Plan model without exposing a half-finished solution.
  return reviewSolutionBlueprint(
    request,
    normalized,
    config.reviewModel,
    signal,
    true,
    false,
    60_000,
  );
}

function buildCanonicalAnswerBlocks(problem: Problem, blueprint: SolutionBlueprint, throughSection = blueprint.sections.length - 1): AnswerBlock[] {
  const sectionCount = Math.max(0, Math.min(blueprint.sections.length, throughSection + 1));
  const sections = blueprint.sections.slice(0, sectionCount);
  const givens = blueprint.givens?.length
    ? blueprint.givens.map((item) => `- ${item}`).join("\n")
    : `- 题目条件与目标：${blueprint.problemSummary || problem.rawText}`;
  const derivation = sections.map((section, index) => [
    `#### ${index + 1}. ${section.title}`,
    section.goal,
    ...section.keyCalculations,
  ].filter(Boolean).join("\n\n")).join("\n\n");
  const materialMethodNote = (blueprint.materialUsage || []).filter((item) => item.applied).map((item) =>
    `- **${item.name}**${item.sourceMode === "VISUAL_ORIGINAL" ? "（已核对课件原页）" : item.sourceMode === "VISUAL_INDEX" ? "（基于课件视觉结构索引）" : ""}：${item.details.join("；") || "沿用该资料中的符号与方法。"}`,
  ).join("\n");
  const base = (type: AnswerBlock["type"], title: string, order: number, plainText: string, status: AnswerBlock["status"] = "GENERATED"): AnswerBlock => ({
    id: `${problem.id}_answer_${type.toLowerCase()}`,
    problemId: problem.id,
    type,
    title,
    plainText,
    latex: "",
    status,
    order,
    version: 1,
    dependencies: order > 1 ? [`${problem.id}_answer_${canonicalAnswerTypes[order - 2].toLowerCase()}`] : [],
  });
  return [
    base("READING", "审题与条件", 1, `${blueprint.problemSummary || "先整理题目给出的条件与求解目标。"}\n\n${givens}`),
    base("METHOD", "方法与依据", 2, `采用 **${blueprint.selectedMethod}**。\n\n${blueprint.methodReason || blueprint.difficultyReason}${materialMethodNote ? `\n\n参考资料的具体作用：\n${materialMethodNote}` : ""}`),
    base("DERIVATION", "推导与计算", 3, derivation || "推导将在讲解过程中逐步补全。"),
    base("RESULT", "最终答案", 4, blueprint.finalConclusion),
    base("CHECK", "检验与总结", 5, blueprint.verification, "VERIFIED"),
  ];
}

function answerBlocksForProgress(problem: Problem, blueprint: SolutionBlueprint, sectionIndex: number, done: boolean) {
  const all = buildCanonicalAnswerBlocks(problem, blueprint, sectionIndex);
  if (done) return all;
  if (sectionIndex === 0) return all.filter((block) => ["READING", "METHOD", "DERIVATION"].includes(block.type));
  return all.filter((block) => block.type === "DERIVATION");
}

function renderMaterialUsage(blueprint: SolutionBlueprint) {
  const used = (blueprint.materialUsage || []).filter((item) => item.applied);
  if (!used.length) return "";
  return `\n\n**本步参考**：${used.map((item) => `${item.name}${item.details[0] ? `（${item.details[0]}）` : ""}`).join("；")}。`;
}

function teachingDraftLooksSafe(value: string) {
  const text = value.trim();
  if (text.length < 30) return false;
  return !/(?:走完|完整步长|实际增量|总变化量|f\s*\(\s*1\s*\).{0,30}(?:≈|约等于|增量)|t\s*=\s*1.{0,35}(?:≈|约等于|增量))/iu.test(text);
}

function personalizedTeachingFallback(request: AgentRequest, blueprint: SolutionBlueprint) {
  const message = request.message?.trim() || "你的回答";
  const problemText = request.problem?.rawText || "";
  const unitDirectionQuestion = /单位化|单位向量|方向导数|两倍|倍数/.test(`${problemText}\n${message}`);
  if (unitDirectionQuestion) {
    return `我先根据你的回答纠正一个容易混淆的点：你说“向量变成两倍，结果也变成两倍”，这个结论只对应**没有单位化时的参数导数**，不是课程定义中的标准方向导数。\n\n标准方向导数描述的是**单位距离上的变化率**，所以要把方向向量除以模长。把方向向量换成同向的 $2\\vec l$ 后，单位方向向量不变，标准方向导数也不变；如果直接计算 $\\nabla u\\cdot(2\\vec l)$，数值确实会变成两倍，但那表示沿参数路径的导数，不能当作标准方向导数。\n\n你刚才的回答里，后半句对应了另一个量，前半句需要按定义修正。请只回答这一点：同一个方向的 $\\vec l$ 和 $2\\vec l$，单位方向向量是否相同？`;
  }
  const current = blueprint.sections[0];
  return `我先结合你刚才的回答调整一下讲法：${message}\n\n这道题当前先抓住“${current.title}”这一板块。${current.intuition || current.explanation || "先明确本步定义和适用条件，再进行计算。"}\n\n**本步关键点**：${current.goal}\n\n请告诉我，你卡住的是定义、符号，还是这一步为什么能这样变形？我会只针对你选的地方继续讲。`;
}

function deliverVerifiedSection(request: AgentRequest, blueprint: SolutionBlueprint): AgentResponse {
  if (!request.problem) throw new Error("缺少当前题目，无法继续讲解。");
  const completed = new Set((request.project?.checkpoints || [])
    .filter((checkpoint) => checkpoint.problemId === request.problem!.id && checkpoint.sectionId)
    .map((checkpoint) => checkpoint.sectionId));
  const sectionIndex = blueprint.sections.findIndex((section) => !completed.has(section.id));
  if (sectionIndex < 0) {
    const blocks = buildCanonicalAnswerBlocks(request.problem, blueprint);
    return normalizeAgentResponse({
      provider: "model",
      assistantMessage: "这道题已经完整讲完了，左侧是整理并校验后的标准答案。你可以继续追问其中任何一步，也可以切换到下一题。",
      stage: "DONE",
      progress: 100,
      selectedMethod: blueprint.selectedMethod,
      answerBlocks: blocks,
      knowledgeCheckpoints: [],
      solutionBlueprint: blueprint,
    });
  }
  const section = blueprint.sections[sectionIndex];
  const total = blueprint.sections.length;
  const done = sectionIndex === total - 1;
  const calculations = section.keyCalculations.length
    ? section.keyCalculations.map((item) => `- ${item}`).join("\n")
    : "- 本步不需要额外计算，重点是理解条件和方法。";
  const pitfalls = section.commonPitfalls.length
    ? section.commonPitfalls.map((item) => `- ${item}`).join("\n")
    : "- 注意保持符号、定义域和推导方向前后一致。";
  const opening = sectionIndex === 0
    ? "好，我们按刚才的掌握情况，从第一步稳稳地开始。"
    : "好，我们接着往下走。这一步只抓住一个核心目标。";
  const assistantMessage = `${opening}\n\n### 第 ${sectionIndex + 1}/${total} 步：${section.title}\n\n**本步目标**：${section.goal}\n\n${section.intuition || section.explanation || "先明确这一步为什么需要做，再完成对应计算。"}\n\n${section.explanation && section.intuition ? section.explanation : ""}\n\n**关键计算**\n\n${calculations}\n\n**容易出错**\n\n${pitfalls}${sectionIndex === 0 ? renderMaterialUsage(blueprint) : ""}\n\n${done ? "到这里整道题已经讲完，左侧标准答案也已一次整理完整。" : "如果这里还有疑问，就直接问这一处；理解后我们再继续下一步。"}`;
  const checkpointId = `lesson_${request.problem.id}_${section.id}`;
  return normalizeAgentResponse({
    provider: "model",
    assistantMessage,
    stage: done ? "DONE" : sectionIndex === 0 ? "EXPLAINING_METHOD" : "DERIVING",
    progress: done ? 100 : Math.max(18, Math.round(((sectionIndex + 1) / total) * 88)),
    selectedMethod: blueprint.selectedMethod,
    answerBlocks: answerBlocksForProgress(request.problem, blueprint, sectionIndex, done),
    knowledgeCheckpoints: [],
    solutionBlueprint: blueprint,
    checkpoint: {
      id: checkpointId,
      title: `完成第 ${sectionIndex + 1} 步：${section.title}`,
      teachingStage: done ? "DONE" : "DERIVING",
      answerBlockIds: answerBlocksForProgress(request.problem, blueprint, sectionIndex, done).map((block) => block.id),
      method: blueprint.selectedMethod,
      createdAt: new Date().toISOString(),
      problemId: request.problem.id,
      sectionId: section.id,
      sectionIndex,
    },
  });
}

async function ensureCanonicalFinalAnswer(request: AgentRequest, response: AgentResponse, model: string, signal?: AbortSignal) {
  const shouldFinalize = request.interaction?.kind === "DIRECT_ANSWER" || response.stage === "DONE" || (response.progress || 0) >= 90;
  if (!shouldFinalize || !request.problem) return response;
  const present = new Set((response.answerBlocks || []).map((block) => block.type));
  if (canonicalAnswerTypes.every((type) => present.has(type))) {
    return { ...response, knowledgeCheckpoint: null, stage: "DONE" as const, progress: 100 };
  }

  void model;
  void signal;
  const blueprint = response.solutionBlueprint || request.project?.problemSolutionBlueprints?.[request.problem.id];
  if (!blueprint) return response;
  const blocks = buildCanonicalAnswerBlocks(request.problem, blueprint);
  return normalizeAgentResponse({
    ...response,
    assistantMessage: response.assistantMessage || "本题讲解已完成，标准答案已同步到左侧。",
    answerBlocks: blocks,
    knowledgeCheckpoint: null,
    knowledgeCheckpoints: [],
    stage: "DONE",
    progress: 100,
    provider: "model",
  });
}

async function generateDirectAnswer(request: AgentRequest, blueprint: SolutionBlueprint, model: string, signal?: AbortSignal) {
  if (!request.problem) throw new Error("缺少当前题目，无法生成完整答案。");
  void model;
  void signal;
  const blocks = buildCanonicalAnswerBlocks(request.problem, blueprint);
  const assistantMessage = `我已经先把整道题核对完成了。下面给出整理后的完整答案，不展示中间试错过程。\n\n${blocks
    .map((block) => `### ${block.title}\n\n${block.plainText}`)
    .join("\n\n")}`;
  return normalizeAgentResponse({
    provider: "model",
    assistantMessage,
    stage: "DONE",
    progress: 100,
    selectedMethod: blueprint.selectedMethod,
    answerBlocks: blocks,
    knowledgeCheckpoints: [],
    solutionBlueprint: blueprint,
  });
}

export async function callModel(request: AgentRequest, signal?: AbortSignal): Promise<AgentResponse> {
  if (request.action === "side_chat") return callSideModel(request, signal);
  if (request.action === "parse_assignment") {
    const messages = [
      { role: "system", content: PARSE_ASSIGNMENT_PROMPT },
      { role: "user", content: request.assignmentText || "" },
    ];
    const content = await chatCompletion(messages, true, 16000, undefined, false, signal);
    let parsed = normalizeAgentResponse({ ...(normalizeJsonLenient(content) as AgentResponse), provider: "model" });
    if (!parsed.problems?.length) {
      const config = runtimeConfig();
      try {
        const repairedContent = await chatCompletion([
          ...messages,
          {
            role: "system",
            content: "上一次结构化结果没有提取出题目。请重新逐行检查题号，只返回包含非空 problems 的合法 JSON；不要输出解释。",
          },
        ], true, 16000, config.solverModel, false, signal);
        parsed = normalizeAgentResponse({ ...(normalizeJsonLenient(repairedContent) as AgentResponse), provider: "model" });
      } catch {
        // Continue to the deterministic splitter below. The OCR text is still
        // useful even when one model response is empty or malformed.
      }
    }
    if (!parsed.problems?.length) {
      const fallbackProblems = splitRecognizedAssignment(request.assignmentText || "");
      if (fallbackProblems.length) {
        return normalizeAgentResponse({ provider: "model", problems: fallbackProblems });
      }
      throw new Error("题目文字已经识别，但没有找到可确认的题干。请检查 PDF 是否只包含答案或空白页。");
    }
    return parsed;
  }
  const config = runtimeConfig();
  const pendingReferences = (request.project?.materials || []).filter((material) =>
    material.category !== "ASSIGNMENT" && ["UPLOADING", "PARSING", "NEEDS_OCR"].includes(material.status),
  );
  if (request.action === "start_problem" && pendingReferences.length) {
    throw new Error(`老师资料仍在解析：${pendingReferences.map((item) => item.name).join("、")}。解析完成后再开始，确保本题真正采用课件中的方法和写法。`);
  }
  const selectedModel = request.responseMode === "fast" ? config.fastModel : config.model;
  const cachedBlueprint = request.problem
    ? request.project?.problemSolutionBlueprints?.[request.problem.id]
    : undefined;
  let solutionBlueprint = cachedBlueprint
    ? normalizeAgentResponse({ provider: "model", solutionBlueprint: cachedBlueprint }).solutionBlueprint
    : undefined;
  if (blueprintContainsCorruptMath(cachedBlueprint, request.problem?.rawText || "") || solutionBlueprint?.qualityVersion !== "verified-v2" || !completeBlueprint(solutionBlueprint) || blueprintContainsCorruptMath(solutionBlueprint, request.problem?.rawText || "") || verifyNumericInverseProduct(request.problem?.rawText || "", solutionBlueprint.finalConclusion)) solutionBlueprint = undefined;
  if (request.problem && !solutionBlueprint) {
    const refs = referenceMaterialsFor(request);
    const cacheKey = stableHash(JSON.stringify({
      projectId: request.project?.id,
      problemId: request.problem.id,
      problem: request.problem.rawText,
      responseMode: request.responseMode,
      references: refs.map((item) => ({ name: item.name, text: item.text })),
      visualReferences: (request.visualReferences || []).map((item) => ({ materialId: item.materialId, name: item.name })),
    }));
    let pending = blueprintRequests.get(cacheKey);
    if (!pending || pending.signal?.aborted) {
      // Direct latency measurements on the complete blueprint prompt show Max
      // finishes a closed JSON answer faster and more reliably than Plus,
      // which often runs to the token limit. Plus remains the independent
      // short reviewer and fallback.
      const solverModel = config.solverModel;
      const promise = buildSolutionBlueprint(request, solverModel, signal).finally(() => {
        if (blueprintRequests.get(cacheKey)?.promise === promise) blueprintRequests.delete(cacheKey);
      });
      pending = { promise, signal };
      blueprintRequests.set(cacheKey, pending);
    }
    solutionBlueprint = await pending.promise;
  }

  if (request.action === "start_problem" && request.problem && solutionBlueprint) {
    const checkpoints = solutionBlueprint.prerequisites.map((item) => ({
      id: item.id,
      name: item.name,
      question: item.question,
      status: "PENDING" as const,
    }));
    return normalizeAgentResponse({
      provider: "model",
      assistantMessage: `我已经先把整道题独立做完并核对过了${solutionBlueprint.materialUsage?.some((item) => item.sourceMode === "VISUAL_ORIGINAL" && item.applied) ? "，并直接核对了你上传的课件原页" : solutionBlueprint.materialUsage?.some((item) => item.sourceMode === "VISUAL_INDEX" && item.applied) ? "，也对照了课件的视觉解析成果" : solutionBlueprint.materialUsage?.some((item) => item.applied) ? "，也对照了你上传的老师资料" : ""}。正式讲解前，我们一次看完下面 ${checkpoints.length} 个前置知识点；选完后我会按你的基础讲清楚，不会把试错过程丢给你。`,
      stage: "CHECKING_PREREQUISITES",
      progress: 5,
      selectedMethod: solutionBlueprint.selectedMethod,
      answerBlocks: [],
      knowledgeCheckpoint: null,
      knowledgeCheckpoints: checkpoints,
      solutionBlueprint,
    });
  }

  if (request.action === "chat" && request.interaction?.kind === "DIRECT_ANSWER" && solutionBlueprint) {
    return generateDirectAnswer(request, solutionBlueprint, selectedModel, signal);
  }

  if (request.action === "chat" && request.interaction?.kind === "KNOWLEDGE_SURVEY" && solutionBlueprint) {
    const assistantMessage = await chatCompletion([
      { role: "system", content: "你是大学课程助教。学生刚反馈基础情况。先简短指出本次讲解会略过什么、重点补什么，然后针对最薄弱且与本题有关的知识点提出一道具体、小而可回答的诊断问题。不是重复询问懂不懂；不要一次问多个问题，不要同时给出答案，也不要提前展开整题。若全部已掌握，问一道应用辨析题；若明确跳过摸底，则尊重选择。只输出中文Markdown，数学用规范LaTeX，不展示内部草稿。" },
      { role: "user", content: JSON.stringify({ problem: request.problem, prerequisites: solutionBlueprint.prerequisites, survey: request.interaction.answers, checkpoints: request.project?.knowledgeCheckpoints, studentFeedback: request.message, firstSection: solutionBlueprint.sections[0] }) },
    ], false, 1500, config.model, false, signal, undefined, 60_000);
    return normalizeAgentResponse({ provider: "model", assistantMessage, stage: "CHECKING_PREREQUISITES", progress: 5, solutionBlueprint, answerBlocks: [] });
  }

  if (request.action === "chat" && request.interaction?.kind === "FREEFORM" && solutionBlueprint) {
    let draft: string;
    try {
      draft = await chatCompletion([
        { role: "system", content: "准确性约束：不能为了通俗而改变定义。导数与方向导数是局部极限变化率，不是走完有限距离后的总变化量；若使用线性近似，必须明确小增量及适用限制。非单位方向向量的点积是沿参数路径的导数，不得说成完整步长的实际增量。先明确纠正学生的错误结论，不要以泛泛赞同开头。内部核对解释与已验证答案一致后再输出。" },
        { role: "system", content: "你是耐心的大学课程助教。依据已核对的解法，直接回应学生这次追问，调整讲解方式和例子，不要重复整道题，不要自行推进讲解进度。只输出中文 Markdown，数学使用 $...$ 或 $$...$$。不输出内部探索草稿。若学生要求未学过的方法，说明当前步骤并给出满足课程限制的等价解释。" },
        { role: "system", content: "如果上一轮提出了诊断问题，本轮必须先结合学生实际回答判断哪一点正确、哪一点需要补充，再用适合其基础的方式讲清。不要泛泛夸奖或机械重放原稿。学生已经掌握的内容简述，薄弱点给具体例子；最后只留一个针对性的理解检查。若学生要求直接讲或跳过，则不强制继续问答。" },
        { role: "user", content: JSON.stringify({ problem: request.problem, solution: solutionBlueprint, learnerProfile: request.project?.knowledgeCheckpoints, recentMessages: request.project?.teachingMessages?.slice(-8), question: request.message }) },
      ], false, 2200, config.solverModel, false, signal, undefined, 45_000);
    } catch (error) {
      if (signal?.aborted) throw error;
      const assistantMessage = personalizedTeachingFallback(request, solutionBlueprint);
      return normalizeAgentResponse({ provider: "model", assistantMessage, stage: "CHECKING_PREREQUISITES", progress: request.project?.progress || 5, solutionBlueprint, answerBlocks: [], knowledgeCheckpoints: [] });
    }
    let assistantMessage = draft;
    try {
      assistantMessage = await chatCompletion([
      { role: "system", content: "你是数学教学终稿审校员。对照题目与已核对解法，检查以下讲解的每个等式、定义、例子和类比，直接输出纠正后的学生可读中文Markdown，不输出审核过程。删掉不能由题目支持的例子；尤其不可把导数当成有限步长实际增量，不允许用参数t=1的线性近似替代局部极限。检查函数初值，不能凭空设为0。先针对学生回答纠正误区，只讲当前疑问，最多500字，末尾最多一个问题。不需要为了纠错而展开整题。" },
      { role: "user", content: JSON.stringify({ problem: request.problem, verifiedSolution: solutionBlueprint, student: request.message, draft: assistantMessage }) },
      ], false, 2200, config.reviewModel, true, signal, 2048, 60_000);
    } catch {
      assistantMessage = teachingDraftLooksSafe(draft)
        ? draft
        : personalizedTeachingFallback(request, solutionBlueprint);
    }
    return normalizeAgentResponse({ provider: "model", assistantMessage, stage: request.project?.teachingStage === "CHECKING_PREREQUISITES" ? "EXPLAINING_METHOD" : request.project?.teachingStage || "EXPLAINING_METHOD", progress: request.project?.progress || 5, solutionBlueprint, answerBlocks: [], knowledgeCheckpoints: [] });
  }

  const lockedLessonInteractions = new Set(["CONTINUE", "SKIP_SECTION"]);
  if (request.action === "chat" && request.interaction?.kind && lockedLessonInteractions.has(request.interaction.kind) && solutionBlueprint) {
    const lesson = deliverVerifiedSection(request, solutionBlueprint);
    if (request.interaction.kind === "SKIP_SECTION" || !lesson.checkpoint) return lesson;
    const currentSection = solutionBlueprint.sections[lesson.checkpoint.sectionIndex ?? 0];
    let assistantMessage: string;
    try {
      assistantMessage = await chatCompletion([
      { role: "system", content: "准确性约束：通俗例子不能改变数学定义。变化率不等于有限距离上的总变化量，线性近似必须说明是局部小增量近似。沿参数路径的导数不能误称为走完整个向量的增量。不要继承历史回复中这些不严谨的措辞；发现时简短澄清。" },
      { role: "system", content: "依据已核对的教学板块和学生的真实反馈，组织这一板块的讲解。明确回应先前诊断暴露的误区，已掌握的略讲，薄弱的用例子和小步推导讲清。保留本板块关键数学结论与条件，不重算整题，不泄露探索草稿。结尾提出一个简短检查问题，等待学生回答。只输出中文Markdown及规范LaTeX。" },
      { role: "system", content: "本次只生成当前板块的补充说明，不生成完整课程、不写步骤编号、不提前讲下一板块。根据学生反馈解释当前板块为什么需要，最多200字，最后一个检查问题只能针对当前板块。当前板块的计算已在页面展示，无需重复或新增数值算例。若学生已掌握，简短确认当前板块的核心条件即可。不得把导数解释为有限步长的实际增量。" },
      { role: "user", content: JSON.stringify({ currentSection, learnerProfile: request.project?.knowledgeCheckpoints, recentMessages: request.project?.teachingMessages?.slice(-8), request: request.message }) },
      ], false, 3000, config.solverModel, true, signal, 2048, 60_000);
    } catch {
      // The verified section is already deterministic and accurate. A
      // provider timeout must not discard it or leave the student with a
      // blank lesson; the next turn can still retry personalization.
      return lesson;
    }
    return { ...lesson, assistantMessage: `${lesson.assistantMessage}\n\n**结合你的反馈**\n\n${assistantMessage}` };
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        action: request.action,
        assignmentText: request.assignmentText,
        message: request.message,
        interaction: request.interaction,
        responseMode: request.responseMode,
        problem: request.problem,
        projectContext: request.project
          ? {
              teachingStage: request.project.teachingStage,
              selectedMethod: request.project.selectedMethod,
              answerBlocks: request.project.answerBlocks,
              recentMessages: request.project.teachingMessages.slice(-8),
              knowledgeCheckpoints: request.project.knowledgeCheckpoints,
              checkpoints: request.project.checkpoints,
              solutionBlueprint,
              referenceMaterials: referenceMaterialsFor(request),
              inheritedCourseProject: request.courseContext
                ? {
                    name: request.courseContext.courseName,
                    description: request.courseContext.courseDescription,
                    relevantKnowledgeNodes: request.courseContext.knowledgeNodes,
                    instruction: "仅课程项目内作业继承这些背景；优先遵循课程资料的方法、符号和定义。",
                  }
                : undefined,
            }
          : undefined,
      }),
    },
  ];
  const mainMaxTokens = request.interaction?.kind === "DIRECT_ANSWER"
    ? 14000
    : request.responseMode === "fast" ? 6000 : 9000;
  const fastTeachingInteractions = new Set(["KNOWLEDGE_SURVEY", "CONTINUE", "SKIP_SECTION"]);
  const deliveryModel = request.action === "chat" && request.interaction?.kind && fastTeachingInteractions.has(request.interaction.kind)
    ? config.fastModel
    : selectedModel;
  let content = await chatCompletion(messages, true, mainMaxTokens, deliveryModel, false, signal);
  let decoded: AgentResponse;
  try {
    decoded = unwrapAgentPayload(normalizeJsonLenient(content));
  } catch {
    content = await chatCompletion([
      ...messages,
      { role: "user", content: "上次输出在 JSON 结束前被截断。请保持数学步骤完整，但压缩重复叙述，并返回一个闭合、可解析、字段完整的 JSON 对象。" },
    ], true, mainMaxTokens, deliveryModel, false, signal);
    decoded = unwrapAgentPayload(normalizeJsonLenient(content));
  }
  let response = normalizeAgentResponse({
    ...decoded,
    provider: "model",
    solutionBlueprint,
    knowledgeCheckpoints: [],
  });
  const needsStructuredLesson = request.action === "chat"
    && request.interaction?.kind !== "FREEFORM"
    && response.stage !== "DONE";
  const violatesTeachingDiscipline = needsStructuredLesson && (
    !response.assistantMessage?.includes("### 第")
    || !response.assistantMessage?.includes("关键计算")
    || /我先试试|换个角度再试|这个方法不一定成立|重新来过/.test(response.assistantMessage || "")
  );
  const invalid = request.action === "analyze_rollback"
    ? !response.rollbackPreview
    : request.action === "chat" && (!response.assistantMessage?.trim() || !response.stage || violatesTeachingDiscipline);
  if (invalid) {
    content = await chatCompletion([
      ...messages,
      { role: "assistant", content },
      { role: "user", content: "上次输出的外层结构、必填字段或教学排版不符合要求。请保留正确结论，重写为字段完整的 JSON；正式讲解必须包含“### 第 x/y 步”“**本步目标**”“**关键计算**”“**容易出错**”，不要出现试错式自我修正。" },
    ], true, mainMaxTokens, deliveryModel, false, signal);
    decoded = unwrapAgentPayload(normalizeJsonLenient(content));
    response = normalizeAgentResponse({
      ...decoded,
      provider: "model",
      solutionBlueprint,
      knowledgeCheckpoints: [],
    });
  }
  if (request.action === "chat" && (!response.assistantMessage?.trim() || !response.stage)) {
    throw new Error("模型本轮没有生成完整讲解，系统已自动重试；请再次发送。当前进度不会丢失。");
  }
  return ensureCanonicalFinalAnswer(request, response, selectedModel, signal);
}

async function callSideModel(request: AgentRequest, signal?: AbortSignal): Promise<AgentResponse> {
  const baseContext = request.problem
    ? `你是当前题目的基础知识助手。优先解释用户做这道题所需的定义、符号、公式含义、适用条件和前置概念，用初学者能理解的语言，从基础讲起；除非用户明确要求，不要代替主讲解窗口继续整道题的推导。用户也可以问无关问题，此时正常回答。所有数学使用 $...$ 或 $$...$$ LaTeX。

当前题目：
${request.problem.rawText}`
    : "你是基础知识助手。用清楚、适合初学者的方式回答用户问题，数学使用 LaTeX。";
  const inheritedCourseContext = request.courseContext
    ? `\n当前作业属于课程项目“${request.courseContext.courseName}”。优先沿用课程资料中的符号、方法与定义；不要把 AI 补充内容伪装成老师原话。\n${JSON.stringify({
        description: request.courseContext.courseDescription,
        relevantKnowledgeNodes: request.courseContext.knowledgeNodes,
        references: request.courseContext.references,
      })}`
    : "\n这是独立作业，不得读取或假设任何课程项目背景。";
  const context = `${baseContext}${inheritedCourseContext}`;
  const history = (request.project?.sideMessages || []).slice(-16).map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content,
  }));
  const config = runtimeConfig();
  const selectedModel = request.responseMode === "fast" ? config.fastModel : config.model;
  const sideAnswer = await chatCompletion([
    { role: "system", content: context },
    ...history,
    { role: "user", content: request.message || "" },
  ], false, undefined, selectedModel, false, signal);
  return normalizeAgentResponse({ provider: "model", sideAnswer });
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

const MAX_INLINE_DOCUMENT_BYTES = 3_600_000;
const MAX_DOCUMENT_PAGES_PER_PART = 8;

type PdfDocumentPart = {
  bytes: Uint8Array;
  startPage: number;
  endPage: number;
};

async function splitPdfForDocumentModel(bytes: Uint8Array): Promise<PdfDocumentPart[]> {
  let source: PDFDocument;
  try {
    source = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch {
    if (bytes.byteLength <= MAX_INLINE_DOCUMENT_BYTES) return [{ bytes, startPage: 1, endPage: 1 }];
    throw new Error("PDF 文件较大且无法按页面拆分。请尝试另存为优化后的 PDF，再重新上传。");
  }
  const pageCount = source.getPageCount();
  if (pageCount <= MAX_DOCUMENT_PAGES_PER_PART && bytes.byteLength <= MAX_INLINE_DOCUMENT_BYTES) {
    return [{ bytes, startPage: 1, endPage: pageCount }];
  }
  const parts: PdfDocumentPart[] = [];
  const renderRange = async (start: number, end: number) => {
    const target = await PDFDocument.create();
    const indexes = Array.from({ length: end - start }, (_, index) => start + index);
    const pages = await target.copyPages(source, indexes);
    pages.forEach((page) => target.addPage(page));
    return target.save({ useObjectStreams: true });
  };
  const visit = async (start: number, end: number): Promise<void> => {
    const partBytes = await renderRange(start, end);
    if (partBytes.byteLength <= MAX_INLINE_DOCUMENT_BYTES && end - start <= MAX_DOCUMENT_PAGES_PER_PART) {
      parts.push({ bytes: partBytes, startPage: start + 1, endPage: end });
      return;
    }
    if (end - start <= 1) {
      throw new Error(`PDF 第 ${start + 1} 页本身超过文档模型的请求上限，请压缩这一页中的图片后重试。`);
    }
    const middle = start + Math.ceil((end - start) / 2);
    await visit(start, middle);
    await visit(middle, end);
  };
  await visit(0, pageCount);
  return parts;
}

async function extractDocumentText(bytes: Uint8Array, fileName: string, mimeType: string, signal?: AbortSignal) {
  const config = runtimeConfig();
  const timed = requestSignal(signal, Math.max(config.modelTimeoutMs, 60_000));
  try {
    const response = await fetch(`${config.tokenPlan.baseUrl}/responses`, {
      signal: timed.signal,
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.tokenPlan.apiKey}`,
        "Content-Type": "application/json",
        "x-dashscope-session-cache": "enable",
      },
      body: JSON.stringify({
        model: config.documentModel,
        max_output_tokens: 12000,
        reasoning: { effort: "low" },
        input: [{
          role: "user",
          content: [
            {
              type: "input_file",
              filename: fileName,
              file_url: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
            },
            {
              type: "input_text",
              text: "请直接阅读这份资料的原始页面。按页面顺序完整提取标题、正文、公式、表格含义、例题和老师强调内容，保留数学符号与层级，输出结构化 Markdown。不要只做摘要，不要猜测看不清的内容。",
            },
          ],
        }],
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Token Plan 文档视觉解析失败（${response.status}）：${detail.slice(0, 240)}`);
    }
    const payload = await response.json();
    const text = extractResponseOutputText(payload) || extractOcrText(payload);
    if (!text?.trim()) throw new Error("Token Plan 文档视觉模型没有返回可用内容");
    return text;
  } finally {
    timed.cleanup();
  }
}

export async function extractVisualPageImagesWithModel(
  pages: Array<{ page: number; name: string; mimeType: string; bytes: Uint8Array }>,
  documentName: string,
  signal?: AbortSignal,
) {
  const config = runtimeConfig();
  const batches = Array.from({ length: Math.ceil(pages.length / 6) }, (_, index) => pages.slice(index * 6, index * 6 + 6));
  const results = new Array<string>(batches.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < batches.length) {
      const batchIndex = cursor;
      cursor += 1;
      const batch = batches[batchIndex];
      const timed = requestSignal(signal, Math.max(config.modelTimeoutMs, 90_000));
      try {
        const response = await fetch(`${config.tokenPlan.baseUrl}/chat/completions`, {
          signal: timed.signal,
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.tokenPlan.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: config.documentModel,
            temperature: 0.1,
            max_tokens: 9000,
            enable_thinking: false,
            messages: [{
              role: "user",
              content: [
                ...batch.map((page) => ({
                  type: "image_url",
                  image_url: { url: `data:${page.mimeType};base64,${bytesToBase64(page.bytes)}` },
                })),
                {
                  type: "text",
                  text: `这些图片依次是《${documentName}》第 ${batch[0].page}-${batch[batch.length - 1].page} 页。请逐页直接阅读原始视觉页面，完整提取题目、标题、正文、公式、表格含义、例题和老师强调内容。保留数学符号、上下标、分式和层级，按“# 第 N 页”分隔输出结构化 Markdown。不要只摘要，不要猜测模糊处。`,
                },
              ],
            }],
          }),
        });
        if (!response.ok) {
          const detail = await response.text();
          throw new Error(`Token Plan 页面视觉解析失败（${response.status}）：${detail.slice(0, 240)}`);
        }
        const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        const text = payload.choices?.[0]?.message?.content?.trim() || "";
        if (!text || /没有(?:收到|上传|附上).*?(?:图片|文件|资料)/u.test(text)) {
          throw new Error(`第 ${batch[0].page}-${batch[batch.length - 1].page} 页没有被视觉模型正确接收。`);
        }
        results[batchIndex] = text;
      } finally {
        timed.cleanup();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, batches.length) }, () => worker()));
  return results.join("\n\n").trim();
}

export async function extractReferenceMaterialWithModel(bytes: Uint8Array, fileName: string, mimeType: string, signal?: AbortSignal) {
  const lowerName = fileName.toLowerCase();
  if (mimeType.startsWith("text/") || /\.(txt|md|markdown)$/i.test(lowerName)) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
    if (!text) throw new Error("这份资料没有可读取的文字内容。");
    return text;
  }
  if (mimeType === "application/pdf" || lowerName.endsWith(".pdf")) {
    const parts = await splitPdfForDocumentModel(bytes);
    if (parts.length === 1) {
      return extractDocumentText(parts[0].bytes, fileName, "application/pdf", signal);
    }
    const extracted: string[] = [];
    for (let offset = 0; offset < parts.length; offset += 2) {
      const batch = parts.slice(offset, offset + 2);
      const texts = await Promise.all(batch.map(async (part) => {
        const pageLabel = part.startPage === part.endPage ? `第 ${part.startPage} 页` : `第 ${part.startPage}-${part.endPage} 页`;
        const partName = fileName.replace(/\.pdf$/i, `-${part.startPage}-${part.endPage}.pdf`);
        const text = await extractDocumentText(part.bytes, partName, "application/pdf", signal);
        return `\n\n# 原资料${pageLabel}\n\n${text}`;
      }));
      extracted.push(...texts);
    }
    return extracted.join("\n").trim();
  }
  if (mimeType.startsWith("image/") || /\.(png|jpe?g|webp|bmp)$/i.test(lowerName)) {
    return extractDocumentText(bytes, fileName, mimeType || "image/png", signal);
  }
  if (
    /\.(pptx?|docx?)$/i.test(lowerName)
    || /application\/(vnd\.(openxmlformats-officedocument|ms-powerpoint|ms-word)|msword)/i.test(mimeType)
  ) {
    return extractDocumentText(bytes, fileName, mimeType || "application/octet-stream", signal);
  }
  throw new Error("当前可直接读取 PDF、PPT/PPTX、Word、图片、TXT 和 Markdown。");
}

export async function parsePdfWithModel(bytes: Uint8Array, fileName: string, signal?: AbortSignal): Promise<{ text: string; problems: Problem[] }> {
  const text = await extractReferenceMaterialWithModel(bytes, fileName, "application/pdf", signal);
  const parsed = await callModel({ action: "parse_assignment", assignmentText: text }, signal);
  return { text, problems: parsed.problems || [] };
}
