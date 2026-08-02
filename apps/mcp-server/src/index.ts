#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BridgeServer } from "./bridge/server.js";
import { loadServerConfig } from "./config.js";
import { JsonLogger } from "./logger.js";
import { createMcpServer } from "./server-factory.js";
import { loadSharedToken } from "./token.js";

async function main(): Promise<void> {
  let logger: JsonLogger | undefined;
  let bridge: BridgeServer | undefined;
  let mcpServer: ReturnType<typeof createMcpServer> | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (reason: string): Promise<void> => {
    shutdownPromise ??= (async () => {
      logger?.log("info", "server_shutdown", { reason });
      await mcpServer?.close().catch(() => undefined);
      await bridge?.close().catch(() => undefined);
      await logger?.flush();
    })();
    return shutdownPromise;
  };

  try {
    const config = loadServerConfig();
    logger = new JsonLogger(config.logDirectory);
    const token = await loadSharedToken(config);
    bridge = new BridgeServer({ host: config.host, port: config.port, token, logger });
    await bridge.start();
    mcpServer = createMcpServer(bridge, logger);

    process.once("SIGINT", () => {
      process.exitCode ??= 0;
      void shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      process.exitCode ??= 0;
      void shutdown("SIGTERM");
    });
    process.once("uncaughtException", (error) => {
      process.exitCode = 1;
      logger?.log("error", "uncaught_exception", { errorName: error.name });
      void shutdown("uncaughtException");
    });
    process.once("unhandledRejection", (reason) => {
      process.exitCode = 1;
      const errorName = reason instanceof Error ? reason.name : "UnknownRejection";
      logger?.log("error", "unhandled_rejection", { errorName });
      void shutdown("unhandledRejection");
    });

    await mcpServer.connect(new StdioServerTransport());
    logger.log("info", "mcp_stdio_ready", { port: config.port });

    const onStdinClosed = (): void => {
      process.exitCode ??= 0;
      void shutdown("stdin_eof");
    };
    process.stdin.once("end", onStdinClosed);
    process.stdin.once("close", onStdinClosed);
    if (process.stdin.readableEnded || process.stdin.destroyed) await shutdown("stdin_eof");
  } catch (error: unknown) {
    logger?.log("error", "startup_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    await shutdown("startup_failure");
    throw error;
  }
}

main().catch((error: unknown) => {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "error", message: "startup_failed", errorName })}\n`);
  process.exitCode = 1;
});
