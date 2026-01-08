import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

import {
  createTerminalContext,
  toolCancel,
  toolConfirm,
  toolDiff,
  toolFindFiles,
  toolGenerateSshKey,
  toolReadFile,
  toolRun,
  toolSearch,
  toolWriteFile
} from './terminalTools.js';

async function main() {
  const ctx = await createTerminalContext();

  const server = new McpServer({
    name: 'terminal-server',
    version: '0.1.0'
  });

  server.registerTool(
    'find_files',
    {
      description:
        'Find files by filename/extension in a directory (optionally follow symlinks). Returns absolute paths sorted by most-recently-modified.',
      inputSchema: z.object({
        dir: z.string().describe('Directory path (relative to sandbox root, or absolute within sandbox)'),
        extensions: z.array(z.string()).optional().describe('Extensions like ["jpg","png"] or [".jpg",".png"]'),
        nameContains: z.string().optional().describe('Case-insensitive substring filter on the filename'),
        maxResults: z.number().int().positive().optional().describe('Max files to return (default 50)'),
        modifiedWithinMinutes: z.number().int().positive().optional().describe('Only files modified within N minutes'),
        followSymlinks: z.boolean().optional().describe('Follow symlinked directories (default true)')
      })
    },
    async ({ dir, extensions, nameContains, maxResults, modifiedWithinMinutes, followSymlinks }) => {
      const res = await toolFindFiles(ctx, { dir, extensions, nameContains, maxResults, modifiedWithinMinutes, followSymlinks });
      return { content: [{ type: 'text', text: res.text }] };
    }
  );

  server.registerTool(
    'generate_ssh_key',
    {
      description: 'Generate an SSH keypair under ~/.ssh (always requires double confirmation).',
      inputSchema: z.object({
        type: z.enum(['ed25519', 'rsa']).optional().describe('Key type (default: ed25519)'),
        filename: z.string().optional().describe('Key filename under ~/.ssh (default: id_ed25519)'),
        comment: z.string().optional().describe('Key comment (default: laya-mcp)'),
        passphrase: z.string().optional().describe('Passphrase (default: empty)'),
        overwrite: z.boolean().optional().describe('Overwrite existing key files (default: false)')
      })
    },
    async ({ type, filename, comment, passphrase, overwrite }) => {
      const res = await toolGenerateSshKey(ctx, { type, filename, comment, passphrase, overwrite });
      return {
        content: [{ type: 'text', text: res.text }],
        structuredContent: res.requiresConfirmation
          ? { requiresConfirmation: true, ...res.requiresConfirmation }
          : { requiresConfirmation: false }
      };
    }
  );

  server.registerTool(
    'run',
    {
      description: 'Run an allowlisted command (no shell). Dangerous commands require double confirmation.',
      inputSchema: z.object({
        command: z.string().describe('Executable name (must be allowlisted)'),
        args: z.array(z.string()).optional().describe('Arguments (array form; no raw shell string)'),
        cwd: z.string().optional().describe('Working directory (relative to sandbox root)')
      })
    },
    async ({ command, args, cwd }) => {
      const res = await toolRun(ctx, { command, args, cwd });
      return {
        content: [{ type: 'text', text: res.text }],
        structuredContent: res.requiresConfirmation
          ? { requiresConfirmation: true, ...res.requiresConfirmation }
          : { requiresConfirmation: false }
      };
    }
  );

  server.registerTool(
    'confirm',
    {
      description: 'Confirm and execute a previously blocked dangerous command.',
      inputSchema: z.object({ token: z.string().describe('Confirmation token from a previous terminal.run') })
    },
    async ({ token }) => {
      const res = await toolConfirm(ctx, { token });
      return { content: [{ type: 'text', text: res.text }] };
    }
  );

  server.registerTool(
    'cancel',
    {
      description: 'Cancel a pending dangerous command confirmation token.',
      inputSchema: z.object({ token: z.string() })
    },
    async ({ token }) => {
      const res = await toolCancel(ctx, { token });
      return { content: [{ type: 'text', text: res.text }] };
    }
  );

  server.registerTool(
    'read_file',
    {
      description: 'Read a file within the sandbox root.',
      inputSchema: z.object({ path: z.string().describe('Path relative to sandbox root') })
    },
    async ({ path }) => {
      const res = await toolReadFile(ctx, { path });
      return { content: [{ type: 'text', text: res.text }] };
    }
  );

  server.registerTool(
    'write_file',
    {
      description: 'Write a file within the sandbox root.',
      inputSchema: z.object({
        path: z.string().describe('Path relative to sandbox root'),
        content: z.string().describe('Content to write'),
        mode: z.enum(['overwrite', 'append', 'create']).optional().describe('Write mode')
      })
    },
    async ({ path, content, mode }) => {
      const res = await toolWriteFile(ctx, { path, content, mode });
      return { content: [{ type: 'text', text: res.text }] };
    }
  );

  server.registerTool(
    'search',
    {
      description: 'Search for a substring within files under sandbox root (simple scan).',
      inputSchema: z.object({
        query: z.string().describe('Substring to search for'),
        maxMatches: z.number().int().positive().optional().describe('Maximum number of matching files to return')
      })
    },
    async ({ query, maxMatches }) => {
      const res = await toolSearch(ctx, { query, maxMatches });
      return { content: [{ type: 'text', text: res.text }] };
    }
  );

  server.registerTool(
    'diff',
    {
      description: 'Show a unified diff for a file (no write).',
      inputSchema: z.object({
        path: z.string().describe('Path relative to sandbox root'),
        newContent: z.string().describe('Proposed new file content')
      })
    },
    async ({ path, newContent }) => {
      const res = await toolDiff(ctx, { path, newContent });
      return { content: [{ type: 'text', text: res.text }] };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('terminal-server error:', err);
  process.exit(1);
});




