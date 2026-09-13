import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const command = process.argv[2] || "dev";
const extraArgs = process.argv.slice(3);
const cli = fileURLToPath(new URL("../node_modules/vinext/dist/cli.js", import.meta.url));
const child = spawn(process.execPath, [cli, command, ...extraArgs], {
  stdio: "inherit",
  env: {
    ...process.env,
    WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || ".wrangler/wrangler.log",
  },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code) => process.exit(code ?? 1));
