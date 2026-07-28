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
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
  const ensureOnPath = (dir) => {
    const currentPath = env[pathKey] ?? "";
    if (!currentPath.toLowerCase().includes(dir.toLowerCase())) {
      env[pathKey] = `${dir};${currentPath}`;
    }
  };

  const cmakeBin = "C:\\Program Files\\CMake\\bin";
  if (existsSync(cmakeBin)) {
    ensureOnPath(cmakeBin);
  }

  // whisper-rs-sys generates its bindings with bindgen, which needs libclang.
  // Point LIBCLANG_PATH at a default LLVM install (and add it to PATH) so the
  // build doesn't fail with "Unable to find libclang".
  const llvmBin = "C:\\Program Files\\LLVM\\bin";
  if (existsSync(`${llvmBin}\\libclang.dll`)) {
    if (!env.LIBCLANG_PATH) {
      env.LIBCLANG_PATH = llvmBin;
    }
    ensureOnPath(llvmBin);
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
