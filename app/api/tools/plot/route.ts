import { NextResponse } from "next/server";
import { callToolServiceBinary } from "@/lib/tool-service-client";

export async function POST(request: Request) {
  try {
    const response = await callToolServiceBinary("/math/plot", await request.json());
    return new Response(response.body, { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "绘图工具调用失败。" }, { status: 502 });
  }
}

