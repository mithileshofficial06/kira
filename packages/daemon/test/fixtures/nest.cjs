// Spawns a chain of N nested node processes (like npm -> node -> dev server).
// Every level prints "PID <pid>" and then idles forever.
const { spawn } = require("node:child_process");

const depth = Number(process.argv[2] ?? 0);
process.stdout.write(`PID ${process.pid}\n`);
if (depth > 0) {
  const child = spawn(process.execPath, [__filename, String(depth - 1)], { stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.pipe(process.stdout);
}
setInterval(() => {}, 1 << 30);
