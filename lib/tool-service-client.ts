import { env } from "cloudflare:workers";

type ToolRuntime = { TOOL_SERVICE_URL?: string; TOOL_SERVICE_TOKEN?: string };

function config() {
  const bindings = env as unknown as ToolRuntime;
  const url = (bindings.TOOL_SERVICE_URL || process.env.TOOL_SERVICE_URL || "").replace(/\/$/, "");
  const token = bindings.TOOL_SERVICE_TOKEN || process.env.TOOL_SERVICE_TOKEN || "";
  if (!url) throw new Error("尚未配置 TOOL_SERVICE_URL。请按 tools-service/README.md 启动确定性工具服务。");
  return { url, token };
}

export async function callToolService(path: string, body: unknown) {
  const runtime = config();
  const response = await fetch(`${runtime.url}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(runtime.token ? { Authorization: `Bearer ${runtime.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(payload.detail || `工具服务调用失败（${response.status}）`));
  return payload;
}

export async function callToolServiceBinary(path: string, body: unknown) {
  const runtime = config();
  const response = await fetch(`${runtime.url}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(runtime.token ? { Authorization: `Bearer ${runtime.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error(String(payload.detail || `工具服务调用失败（${response.status}）`));
  }
  return response;
}

