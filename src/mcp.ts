import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { dbPath } from './config.js';
import { projectFromCwd } from './core/project.js';
import { createServer } from './mcp/server.js';
import { openDb } from './storage/db.js';

// stdout is the MCP protocol channel: never console.log in this process.
const dbFile = dbPath();
const db = openDb(dbFile);
const server = createServer({ db, dbFile, defaultProject: projectFromCwd(process.cwd()) });
await server.connect(new StdioServerTransport());

const shutdown = () => {
  try {
    db.close();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
