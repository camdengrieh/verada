// Runs a command with its stdout and stderr appended to a log file, scrubbed of the secrets listed in
// $DEV_REDACT (JSON array). Started detached by lib.spawnLogged; SIGTERM/SIGINT stop the child too.
//   node run-logged.mjs <logfile> -- <cmd> [args...]
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { redact } from "./lib.mjs";

const [logFile, sep, cmd, ...args] = process.argv.slice(2);
if (!logFile || sep !== "--" || !cmd) {
  console.error("usage: run-logged.mjs <logfile> -- <cmd> [args...]");
  process.exit(2);
}
let secrets = [];
try {
  secrets = JSON.parse(process.env.DEV_REDACT ?? "[]");
} catch {
  /* no secrets */
}
const env = { ...process.env };
delete env.DEV_REDACT;

const log = createWriteStream(logFile, { flags: "a", mode: 0o600 });
const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });

function pipe(stream) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) log.write(`${redact(l, secrets)}\n`);
  });
  stream.on("end", () => {
    if (buf) log.write(`${redact(buf, secrets)}\n`);
  });
}
pipe(child.stdout);
pipe(child.stderr);

child.on("error", (e) => {
  log.write(`failed to start ${cmd}: ${redact(e.message, secrets)}\n`);
  log.end(() => process.exit(127));
});
child.on("close", (code, signal) => {
  log.write(`[exit ${signal ?? code}]\n`);
  log.end(() => process.exit(typeof code === "number" ? code : 1));
});

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    child.kill("SIGTERM");
    // The child gets a few seconds to wind down; the group kill from dev:down is the backstop.
    setTimeout(() => child.kill("SIGKILL"), 6000).unref();
  });
}
