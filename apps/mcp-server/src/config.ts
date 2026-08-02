import { homedir } from "node:os";
import { join } from "node:path";

export const SERVER_NAME = "sol-indesign-mcp";
export const SERVER_VERSION = "0.1.0";
export const DEFAULT_BRIDGE_HOST = "127.0.0.1";
export const DEFAULT_BRIDGE_PORT = 32_145;

export interface ServerConfig {
  readonly host: typeof DEFAULT_BRIDGE_HOST;
  readonly port: number;
  readonly credentialPath: string;
  readonly logDirectory: string;
}

function localAppData(): string {
  const value = process.env.LOCALAPPDATA;
  if (value !== undefined && value.length > 0) return value;
  return join(homedir(), "AppData", "Local");
}

export function loadServerConfig(): ServerConfig {
  const rawPort = process.env.SOL_INDESIGN_MCP_PORT ?? String(DEFAULT_BRIDGE_PORT);
  const port = /^\d{1,5}$/u.test(rawPort) ? Number(rawPort) : Number.NaN;
  const allowTestPort = process.env.SOL_INDESIGN_MCP_ALLOW_TEST_PORT === "1";
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("SOL_INDESIGN_MCP_PORT must be a valid TCP port.");
  }
  if (!allowTestPort && port !== DEFAULT_BRIDGE_PORT) {
    throw new Error(`Production bridge port must be ${DEFAULT_BRIDGE_PORT}.`);
  }
  const dataRoot = join(localAppData(), "Sol", "InDesign MCP");
  return {
    host: DEFAULT_BRIDGE_HOST,
    port,
    credentialPath: join(dataRoot, "credentials.json"),
    logDirectory: join(dataRoot, "logs"),
  };
}
