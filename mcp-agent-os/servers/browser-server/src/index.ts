import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

import { notImplemented } from './browserTools.js';

async function main() {
  const server = new McpServer({ name: 'browser-server', version: '0.1.0' });

  server.registerTool(
    'open_url',
    {
      description: '(stub) Open a URL in a browser',
      inputSchema: z.object({ url: z.string() })
    },
    async () => ({ content: [{ type: 'text', text: notImplemented('open_url').text }] })
  );

  server.registerTool(
    'search',
    {
      description: '(stub) Search the web',
      inputSchema: z.object({ query: z.string() })
    },
    async () => ({ content: [{ type: 'text', text: notImplemented('search').text }] })
  );

  server.registerTool(
    'run_action',
    {
      description: '(stub) Run a browser action (click/type/etc.)',
      inputSchema: z.object({ action: z.string(), args: z.record(z.string(), z.any()).optional() })
    },
    async () => ({ content: [{ type: 'text', text: notImplemented('run_action').text }] })
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('browser-server error:', err);
  process.exit(1);
});




