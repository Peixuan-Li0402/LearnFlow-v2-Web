import { env } from "cloudflare:workers";

export const runtime = "edge";

type HealthEnv = {
  DB?: D1Database;
  UPLOADS?: R2Bucket;
  MODEL_API_KEY?: string;
  TOKEN_PLAN_API_KEY?: string;
};

export async function GET() {
  const bindings = env as unknown as HealthEnv;
  const checks = {
    database: Boolean(bindings.DB),
    objectStorage: Boolean(bindings.UPLOADS),
    modelProvider: Boolean(bindings.MODEL_API_KEY || bindings.TOKEN_PLAN_API_KEY),
  };
  const ready = checks.database && checks.objectStorage && checks.modelProvider;
  return Response.json({
    name: "LearnFlow",
    status: ready ? "ok" : "degraded",
    version: "2.0.0",
    time: new Date().toISOString(),
    checks,
  }, { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
