type ModelCallError = Error & { status?: number; detail?: string };

function statusOf(error: unknown) {
  return error && typeof error === "object" && "status" in error
    ? Number((error as ModelCallError).status)
    : undefined;
}

function detailOf(error: unknown) {
  if (!(error instanceof Error)) return String(error || "");
  return `${error.message} ${"detail" in error ? String((error as ModelCallError).detail || "") : ""}`;
}

export function isRetryableModelError(error: unknown) {
  const status = statusOf(error);
  if (status !== undefined) return [408, 409, 425, 429].includes(status) || status >= 500;
  return error instanceof TypeError
    || /empty|空内容|timeout|timed out|响应超过|fetch failed|network|connection|socket|econnreset|econnrefused|terminated/i.test(detailOf(error));
}

export function canTryAnotherModel(error: unknown) {
  const status = statusOf(error);
  if (status === 401) return false;
  if (status === 400) return /model|unsupported|not.?found|invalid.?parameter|response.?format/i.test(detailOf(error));
  if (status === 403) return /quota|allocation|permission|access|model|free.?tier|limit/i.test(detailOf(error));
  return isRetryableModelError(error);
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error("请求已取消"));
      return;
    }
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason || new Error("请求已取消"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Retries transient failures and then changes model within the same Token Plan.
 * Invalid credentials and deterministic client errors still fail immediately.
 */
export async function runModelCandidates<T>(
  models: Array<string | null | undefined>,
  invoke: (model: string, attempt: number) => Promise<T>,
  options: { signal?: AbortSignal; attemptsPerModel?: number } = {},
) {
  const candidates = [...new Set(models.filter((model): model is string => Boolean(model?.trim())).map((model) => model.trim()))];
  const attemptsPerModel = Math.max(1, options.attemptsPerModel || 2);
  let lastError: unknown = new Error("没有可用模型");

  for (let modelIndex = 0; modelIndex < candidates.length; modelIndex += 1) {
    const model = candidates[modelIndex];
    for (let attempt = 0; attempt < attemptsPerModel; attempt += 1) {
      if (options.signal?.aborted) throw options.signal.reason || new Error("请求已取消");
      try {
        return await invoke(model, attempt);
      } catch (error) {
        lastError = error;
        if (options.signal?.aborted) throw options.signal.reason || error;
        if (!isRetryableModelError(error) || attempt + 1 >= attemptsPerModel) break;
        await wait(450 * (2 ** attempt) + Math.floor(Math.random() * 180), options.signal);
      }
    }
    if (!canTryAnotherModel(lastError) || modelIndex + 1 >= candidates.length) break;
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || "模型调用失败"));
}
