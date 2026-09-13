const MAX_CHUNK_CHARS = 1400;

function clean(value: string) {
  return value.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function terms(value: string) {
  const normalized = value.toLowerCase();
  const result = new Set<string>();
  for (const word of normalized.match(/[a-z][a-z0-9_'-]{1,}|\\[a-z]+|\d+(?:\.\d+)?/g) || []) result.add(word);
  for (const segment of normalized.match(/[\u3400-\u9fff]{2,}/g) || []) {
    for (let size = 2; size <= Math.min(4, segment.length); size += 1) {
      for (let index = 0; index + size <= segment.length; index += 1) result.add(segment.slice(index, index + size));
    }
  }
  return result;
}

function splitLongParagraph(paragraph: string) {
  if (paragraph.length <= MAX_CHUNK_CHARS) return [paragraph];
  const parts: string[] = [];
  for (let offset = 0; offset < paragraph.length; offset += MAX_CHUNK_CHARS) {
    parts.push(paragraph.slice(offset, offset + MAX_CHUNK_CHARS));
  }
  return parts;
}

export function chunkReferenceText(text: string) {
  const paragraphs = clean(text).split(/\n\s*\n|(?=第\s*\d+\s*(?:页|章|节))|(?=#{1,4}\s)/u).flatMap(splitLongParagraph);
  const chunks: string[] = [];
  let buffer = "";
  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) continue;
    if (buffer && buffer.length + paragraph.length + 2 > MAX_CHUNK_CHARS) {
      chunks.push(buffer.trim());
      buffer = "";
    }
    buffer += `${buffer ? "\n\n" : ""}${paragraph.trim()}`;
  }
  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks;
}

export function buildReferenceDigest(text: string, maxChars = 2400) {
  const cleaned = clean(text);
  const lines = cleaned.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const important = lines.filter((line) =>
    /定义|定理|推论|公式|性质|结论|条件|方法|步骤|注意|易错|例题|解：|证明|特征函数|概率密度|分布函数|期望|方差|微分方程/u.test(line)
    || /\\(?:frac|int|sum|lim|phi|varphi|mathbb|mathrm)|\$[^$]+\$/u.test(line),
  );
  const selected = [...lines.slice(0, 12), ...important].filter((line, index, all) => all.indexOf(line) === index);
  return selected.join("\n").slice(0, maxChars) || cleaned.slice(0, maxChars);
}

export function selectRelevantReferenceText(text: string, query: string, maxChars = 7200) {
  const chunks = chunkReferenceText(text);
  if (!chunks.length) return "";
  const queryTerms = terms(query);
  const ranked = chunks.map((chunk, index) => {
    const chunkTerms = terms(chunk);
    let score = index === 0 ? 1 : 0;
    for (const term of queryTerms) {
      if (chunkTerms.has(term)) score += term.length >= 4 ? 4 : 1;
    }
    if (/定义|定理|公式|例题|解：|证明/u.test(chunk)) score += 1;
    return { chunk, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected: string[] = [];
  let used = 0;
  for (const item of ranked) {
    if (selected.length >= 6 || used >= maxChars) break;
    const remaining = maxChars - used;
    selected.push(item.chunk.slice(0, remaining));
    used += Math.min(item.chunk.length, remaining);
  }
  return selected.join("\n\n---\n\n");
}
