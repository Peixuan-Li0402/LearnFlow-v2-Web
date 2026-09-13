/** Public errors never contain provider payloads, credentials or stack traces. */
export function agentErrorMessage(error: unknown) {
  const e = error as { status?: number; message?: string; name?: string };
  const message = typeof e?.message === "string" ? e.message : "";
  if (e?.status === 401 || e?.status === 403 || /AccessDenied|PERMISSION_DENIED|quota.*exhausted/i.test(message))
    return "模型服务当前没有访问权限或额度，未生成答案。已上传资料仍保留，请检查服务配置后重试。";
  if (e?.status === 429) return "模型服务当前繁忙，未生成答案。请稍后重试，已上传资料不受影响。";
  if (/timeout|超时|响应超过|timed out/i.test(message) || e?.name === "TimeoutError")
    return "本次解题超过等待时限，已停止请求。题目和资料仍保留，可以重试或切换模型服务。";
  if (/JSON|结构化|蓝图/.test(message)) return "模型返回的解题内容不完整，系统没有发布该答案。请重试本题，题目与资料已保留。";
  if (/fetch|network|connection/i.test(message)) return "连接模型服务失败，请检查网络后重试。题目与资料已保留。";
  return "本次解题未能完成，请重试。系统没有生成替代答案，题目与资料仍保留。";
}
