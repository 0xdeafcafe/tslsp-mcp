#!/usr/bin/env node
import { start } from "./mcp.js";

start().catch((e) => {
  process.stderr.write(`tslsp-mcp fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
