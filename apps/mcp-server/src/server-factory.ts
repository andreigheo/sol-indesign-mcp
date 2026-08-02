import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeServer } from "./bridge/server.js";
import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import type { JsonLogger } from "./logger.js";
import { registerTools, SERVER_INSTRUCTIONS } from "./mcp/register-tools.js";

export function createMcpServer(bridge: BridgeServer, logger: JsonLogger): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, bridge, logger);
  return server;
}
