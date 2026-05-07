import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const hasCommand = args.length > 0;
const command = hasCommand ? args[0] : "dev";
const passthroughArgs = hasCommand ? args.slice(1) : [];
const needsDevConfig = command === "dev";
const tauriArgs = needsDevConfig
  ? [command, "--config", "src-tauri/tauri.dev.conf.json", ...passthroughArgs]
  : args;

const isWindows = process.platform === "win32";
const commandName = isWindows ? "cmd.exe" : "npx";
const commandArgs = isWindows
  ? ["/d", "/s", "/c", "npx", "tauri", ...tauriArgs]
  : ["tauri", ...tauriArgs];

const env = { ...process.env };
if (isWindows) {
  const cmakeBin = "C:\\Program Files\\CMake\\bin";
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
  const currentPath = env[pathKey] ?? "";
  if (existsSync(cmakeBin) && !currentPath.toLowerCase().includes(cmakeBin.toLowerCase())) {
    env[pathKey] = `${cmakeBin};${currentPath}`;
  }
}

const child = spawn(commandName, commandArgs, {
  stdio: "inherit",
  shell: false,
  env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
