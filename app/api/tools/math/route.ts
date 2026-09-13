import { NextResponse } from "next/server";
import { callToolService } from "@/lib/tool-service-client";

export async function POST(request: Request) {
  try {
    const result = await callToolService("/math/evaluate", await request.json());
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "数学工具调用失败。" }, { status: 502 });
  }
}

