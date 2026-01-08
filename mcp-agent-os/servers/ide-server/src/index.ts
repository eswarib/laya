import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

import { notImplemented } from './ideTools.js';

async function main() {
  const server = new McpServer({ name: 'ide-server', version: '0.1.0' });

  server.registerTool(
    'open_project',
    {
      description: '(stub) Open an IDE project',
      inputSchema: z.object({ path: z.string() })
    },
    async () => ({ content: [{ type: 'text', text: notImplemented('open_project').text }] })
  );

  server.registerTool(
    'build',
    {
      description: '(stub) Build the project',
      inputSchema: z.object({ target: z.string().optional() })
    },
    async () => ({ content: [{ type: 'text', text: notImplemented('build').text }] })
  );

  server.registerTool(
    'find_file',
    {
      description: '(stub) Find a file in the project',
      inputSchema: z.object({ query: z.string() })
    },
    async () => ({ content: [{ type: 'text', text: notImplemented('find_file').text }] })
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('ide-server error:', err);
  process.exit(1);
});




