#!/usr/bin/env node
import { OpenApiExplorerServer } from './server.js';

// Tool handlers catch their own errors; anything reaching here is a bug worth a visible exit.
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`openapi-explorer-mcp: unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`);
  process.exit(1);
});

const server = await OpenApiExplorerServer.fromEnvironment();
await server.start();
