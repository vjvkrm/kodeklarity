#!/usr/bin/env node
import { startMcpServer } from "../src/mcp-server.js";

startMcpServer().catch((err) => {
  console.error("MCP server failed:", err);
  process.exit(1);
});
