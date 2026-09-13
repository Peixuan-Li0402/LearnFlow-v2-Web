import { env } from "cloudflare:workers";
import type { MaterialChunk } from "./course-types";

type VectorRuntime = {
  VECTORIZE?: VectorizeIndex;
  TOKEN_PLAN_API_KEY?: string;
  TOKEN_PLAN_BASE_URL?: string;
  EMBEDDING_MODEL?: string;
};

function runtime() {
  const bindings = env as unknown as VectorRuntime;
  return {
    index: bindings.VECTORIZE,
    apiKey: bindings.TOKEN_PLAN_API_KEY || process.env.TOKEN_PLAN_API_KEY || "",
    baseUrl: (bindings.TOKEN_PLAN_BASE_URL || process.env.TOKEN_PLAN_BASE_URL || "").replace(/\/$/, ""),
    model: bindings.EMBEDDING_MODEL || process.env.EMBEDDING_MODEL || "",
  };
}

async function embed(texts: string[]) {
  const config = runtime();
  if (!config.apiKey || !config.baseUrl || !config.model) return null;
  const response = await fetch(`${config.baseUrl}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.model, input: texts }),
  });
  if (!response.ok) throw new Error(`向量模型调用失败（${response.status}）：${(await response.text()).slice(0, 220)}`);
  const payload = (await response.json()) as { data?: Array<{ index: number; embedding: number[] }> };
  const vectors = (payload.data || []).sort((a, b) => a.index - b.index).map((item) => item.embedding);
  if (vectors.length !== texts.length) throw new Error("向量模型返回的条目数量不完整。");
  return vectors;
}

export async function indexCourseChunksVector(chunks: MaterialChunk[]) {
  const config = runtime();
  if (!config.index || !config.model) return { available: false, indexed: 0 };
  let indexed = 0;
  for (let start = 0; start < chunks.length; start += 24) {
    const batch = chunks.slice(start, start + 24);
    const vectors = await embed(batch.map((chunk) => `${chunk.heading}\n${chunk.text}`));
    if (!vectors) return { available: false, indexed };
    await config.index.upsert(batch.map((chunk, index) => ({
      id: chunk.id,
      values: vectors[index],
      metadata: {
        courseId: chunk.courseId,
        materialId: chunk.materialId,
        sequence: chunk.sequence,
        heading: chunk.heading.slice(0, 180),
      },
    })));
    indexed += batch.length;
  }
  return { available: true, indexed };
}

export async function queryCourseVector(courseId: string, query: string, limit = 18) {
  const config = runtime();
  if (!config.index || !config.model) return [] as string[];
  const vectors = await embed([query]);
  if (!vectors) return [] as string[];
  const result = await config.index.query(vectors[0], {
    topK: limit,
    filter: { courseId: { $eq: courseId } },
    returnMetadata: "all",
  });
  return result.matches.map((match) => match.id);
}
