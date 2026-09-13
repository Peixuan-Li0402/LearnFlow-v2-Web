import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const workerEntry = fileURLToPath(new URL("../dist/server/index.js", import.meta.url));
const vinextCli = fileURLToPath(new URL("../node_modules/vinext/dist/cli.js", import.meta.url));
const wranglerCli = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || ".wrangler/wrangler.log",
      },
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`command exited with ${code}`))));
  });
}

if (!existsSync(workerEntry)) {
  await run(process.execPath, [vinextCli, "build"]);
}

const args = [wranglerCli, "dev", "--config", "wrangler.local.jsonc"];
if (existsSync(fileURLToPath(new URL("../.env.local", import.meta.url)))) {
  args.push("--env-file", ".env.local");
}
args.push(...process.argv.slice(2));
await run(process.execPath, args);
