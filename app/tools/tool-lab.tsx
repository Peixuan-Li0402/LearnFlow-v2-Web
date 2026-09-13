"use client";
/* eslint-disable @next/next/no-img-element -- plot output is a transient data URL from the tool service */

import { ArrowLeft, Braces, CircleAlert, Code2, FunctionSquare, LoaderCircle, Play, Send } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { MarkdownMath } from "@/app/markdown-math";

type MathResult = { result?: string; latex?: string; verified?: boolean; difference?: string; method?: string; error?: string };

export function ToolLab() {
  const [tab, setTab] = useState<"math" | "plot" | "oj">("math");
  const [expression, setExpression] = useState("sin(x)^2 + cos(x)^2");
  const [secondExpression, setSecondExpression] = useState("1");
  const [action, setAction] = useState("verify");
  const [result, setResult] = useState<MathResult | null>(null);
  const [plotUrl, setPlotUrl] = useState("");
  const [code, setCode] = useState("print(sum(map(int, input().split())))");
  const [stdin, setStdin] = useState("2 3");
  const [languageId, setLanguageId] = useState(71);
  const [ojResult, setOjResult] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const runMath = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/tools/math", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, expression, second_expression: secondExpression, variable: "x", point: secondExpression }) });
      const payload = await response.json() as MathResult;
      if (!response.ok) throw new Error(payload.error || "数学工具失败");
      setResult(payload);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "数学工具失败"); }
    finally { setBusy(false); }
  };

  const runPlot = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/tools/plot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expression, variable: "x", minimum: -10, maximum: 10 }) });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error || "绘图失败");
      if (plotUrl) URL.revokeObjectURL(plotUrl);
      setPlotUrl(URL.createObjectURL(await response.blob()));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "绘图失败"); }
    finally { setBusy(false); }
  };

  const runOj = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/tools/oj", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source_code: code, language_id: languageId, stdin }) });
      const payload = await response.json() as Record<string, unknown> & { error?: string };
      if (!response.ok) throw new Error(payload.error || "OJ 沙箱失败");
      setOjResult(payload);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "OJ 沙箱失败"); }
    finally { setBusy(false); }
  };

  return (
    <main className="tool-lab-shell">
      <header><Link href="/learn"><ArrowLeft size={17} />返回课程空间</Link><div><Braces size={22} /><span><strong>确定性工具实验室</strong><small>模型负责解释，工具负责验证；不伪造运行结果</small></span></div></header>
      <nav><button className={tab === "math" ? "active" : ""} onClick={() => setTab("math")}><FunctionSquare size={17} />符号验证</button><button className={tab === "plot" ? "active" : ""} onClick={() => setTab("plot")}><Play size={17} />函数绘图</button><button className={tab === "oj" ? "active" : ""} onClick={() => setTab("oj")}><Code2 size={17} />OJ 沙箱</button></nav>
      {error && <div className="tool-error"><CircleAlert size={16} />{error}</div>}
      {tab === "math" && <section className="tool-grid"><div className="tool-form"><label>动作<select value={action} onChange={(event) => setAction(event.target.value)}><option value="verify">等价验证</option><option value="simplify">化简</option><option value="derivative">求导</option><option value="integral">不定积分</option><option value="limit">极限</option><option value="solve">解方程</option><option value="substitute">数值代回</option></select></label><label>表达式<textarea value={expression} onChange={(event) => setExpression(event.target.value)} /></label>{["verify", "solve", "limit"].includes(action) && <label>{action === "limit" ? "趋近点" : "另一边的表达式"}<input value={secondExpression} onChange={(event) => setSecondExpression(event.target.value)} /></label>}<button onClick={() => void runMath()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}运行 SymPy</button></div><div className="tool-output">{result ? <><span>{result.method}</span>{result.latex && <MarkdownMath content={`$$${result.latex}$$`} />}<pre>{JSON.stringify(result, null, 2)}</pre></> : <p>结果来自独立工具服务，不由语言模型猜测。</p>}</div></section>}
      {tab === "plot" && <section className="tool-grid"><div className="tool-form"><label>函数表达式<textarea value={expression} onChange={(event) => setExpression(event.target.value)} /></label><button onClick={() => void runPlot()} disabled={busy}><Play size={16} />生成图像</button></div><div className="tool-output plot-output">{plotUrl ? <img src={plotUrl} alt="函数图像" /> : <p>默认绘制 $x\in[-10,10]$。</p>}</div></section>}
      {tab === "oj" && <section className="tool-grid"><div className="tool-form"><label>语言<select value={languageId} onChange={(event) => setLanguageId(Number(event.target.value))}><option value={71}>Python 3</option><option value={54}>C++</option><option value={62}>Java</option><option value={63}>JavaScript</option></select></label><label>代码<textarea className="code-area" value={code} onChange={(event) => setCode(event.target.value)} /></label><label>标准输入<textarea value={stdin} onChange={(event) => setStdin(event.target.value)} /></label><button onClick={() => void runOj()} disabled={busy}><Play size={16} />提交到 Judge0</button></div><div className="tool-output">{ojResult ? <pre>{JSON.stringify(ojResult, null, 2)}</pre> : <p>OJ 只返回编译、运行、超时和输出信息，不给用户评分。</p>}</div></section>}
    </main>
  );
}
