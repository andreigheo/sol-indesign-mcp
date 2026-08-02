import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const entry = resolve(import.meta.dirname, "..", "apps", "mcp-server", "dist", "index.js");
const child = spawn(process.execPath, [entry], {
  env: {
    ...process.env,
    SOL_INDESIGN_MCP_TOKEN: randomBytes(32).toString("base64url"),
    SOL_INDESIGN_MCP_PORT: "0",
    SOL_INDESIGN_MCP_ALLOW_TEST_PORT: "1",
  },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });

const closePromise = new Promise((resolveClose) => {
  child.once("close", (code, signal) => resolveClose({ code, signal }));
});

function waitForReady() {
  return new Promise((resolveReady) => {
    const check = () => {
      if (!stderr.includes('"message":"mcp_stdio_ready"')) return;
      child.stderr.off("data", check);
      resolveReady();
    };
    child.stderr.on("data", check);
    check();
  });
}

async function withTimeout(promise, timeoutMs, message) {
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
  });
  return await Promise.race([promise, timeout]);
}

try {
  await withTimeout(
    Promise.race([
      waitForReady(),
      closePromise.then(({ code, signal }) => {
        throw new Error(`MCP server exited before readiness (code=${code}, signal=${signal}): ${stderr.slice(-2_000)}`);
      }),
    ]),
    8_000,
    `MCP server did not become ready: ${stderr.slice(-2_000)}`,
  );
  if (child.exitCode !== null) throw new Error(`MCP server exited immediately after readiness: ${stderr.slice(-2_000)}`);
  if (stdout.length !== 0) throw new Error(`MCP server emitted non-protocol startup output on stdout: ${stdout.slice(0, 500)}`);

  child.stdin.end();
  const closed = await withTimeout(
    closePromise,
    5_000,
    "MCP server did not shut down after its STDIO client reached EOF.",
  );
  if (closed.code !== 0 || closed.signal !== null) {
    throw new Error(`MCP server did not exit cleanly after STDIO EOF (code=${closed.code}, signal=${closed.signal}): ${stderr.slice(-2_000)}`);
  }
  if (stdout.length !== 0) throw new Error(`MCP server emitted unsolicited stdout during shutdown: ${stdout.slice(0, 500)}`);
} catch (error) {
  if (child.exitCode === null) {
    child.kill();
    await closePromise;
  }
  throw error;
}

process.stdout.write("MCP server became ready, kept stdout pure, and exited cleanly on STDIO EOF.\n");
