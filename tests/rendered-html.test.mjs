import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("build emits the LearnFlow workspace assets", async () => {
  const assetRoot = new URL("../dist/client/assets/", import.meta.url);
  const files = await readdir(assetRoot);
  const appAsset = files.find((name) => name.startsWith("homework-agent-app-") && name.endsWith(".js"));
  const cssAsset = files.find((name) => name.startsWith("index-") && name.endsWith(".css"));
  assert.ok(appAsset, "client app asset missing");
  assert.ok(cssAsset, "client stylesheet missing");
  const [appJs, css] = await Promise.all([
    readFile(new URL(appAsset, assetRoot), "utf8"),
    readFile(new URL(cssAsset, assetRoot), "utf8"),
  ]);
  assert.match(appJs, /LearnFlow/);
  assert.match(appJs, /标准答案/);
  assert.match(appJs, /讲解与思路/);
  assert.match(appJs, /知识助手/);
  assert.match(appJs, /选择作业 PDF/);
  assert.match(appJs, /新建作业/);
  assert.match(appJs, /新建课程项目/);
  assert.match(appJs, /进入课程空间/);
  assert.match(appJs, /独立作业/);
  assert.doesNotMatch(appJs, /空白作业|直接导入作业/);
  assert.match(appJs, /预计剩余/);
  assert.match(appJs, /快速/);
  assert.match(appJs, /思考/);
  assert.match(appJs, /Shift \+ Enter/);
  assert.match(css, /workspace-grid/);
  assert.match(css, /pdf-progress-track/);
  assert.match(css, /response-mode/);
  assert.match(css, /max-height:calc\(100vh - 24px\)/);
  assert.doesNotMatch(appJs, /Your site is taking shape|Codex is working|codex-preview/i);
});

test("removes disposable starter assets and keeps product metadata", async () => {
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
  const [page, layout, packageJson, hosting] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
  ]);
  assert.match(page, /HomeworkAgentApp/);
  assert.match(layout, /lang="zh-CN"/);
  assert.match(layout, /大学课程学习与期末冲刺 Agent/);
  assert.match(packageJson, /"version": "2\.0\.0"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(hosting, /"d1": "DB"/);
  assert.match(hosting, /"r2": "UPLOADS"/);
  await access(new URL("../public/assistant-avatar.jpg", import.meta.url));
  await access(root);
});

test("local preview serves built assets before the worker router", async () => {
  const config = await readFile(new URL("../wrangler.local.jsonc", import.meta.url), "utf8");
  assert.match(config, /"directory": "\.\/dist\/client"/);
  assert.match(config, /"run_worker_first": false/);
});
