#!/usr/bin/env node
import { runBrowserServer } from "./browser-server.js";

void runBrowserServer().catch((error) => {
  console.error("Failed to start Paperclip browser MCP server:", error);
  process.exit(1);
});
