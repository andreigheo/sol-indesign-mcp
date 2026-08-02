import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const targets = [
  "apps/mcp-server/dist",
  "apps/indesign-uxp/dist",
  "packages/protocol/dist",
  "packages/domain/dist",
  "packages/security/dist",
  "packages/testkit/dist",
  "coverage",
  "artifacts",
  "apps/indesign-uxp/artifacts",
];

await Promise.all(targets.map(async (target) => await rm(resolve(root, target), { recursive: true, force: true })));
process.stdout.write("Cleaned generated build, coverage, and package artifacts.\n");
