import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';

export type ServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

export type McpJson = {
  servers: Record<string, ServerConfig>;
};

export type ToolInfo = {
  name: string;
  description?: string;
  // MCP tools include an inputSchema; keep it as unknown for prompt rendering.
  inputSchema?: unknown;
};

export type ConnectedServer = {
  name: string;
  config: ServerConfig;
  client: Client;
  transport: StdioClientTransport;
  tools: ToolInfo[];
};

export async function connectServer(
  name: string,
  config: ServerConfig,
  baseDir: string
): Promise<ConnectedServer> {
  const client = new Client(
    { name: 'mcp-agent-os-client', version: '0.1.0' },
    { capabilities: {} }
  );

  const cwd = config.cwd
    ? path.isAbsolute(config.cwd)
      ? config.cwd
      : path.resolve(baseDir, config.cwd)
    : baseDir;

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: config.env,
    cwd,
    stderr: 'pipe'
  });

  // Pipe server stderr to client stderr for easier debugging.
  transport.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[${name} stderr] ${String(chunk)}`);
  });

  await client.connect(transport);
  const toolsResp = await client.listTools();

  const tools: ToolInfo[] = (toolsResp.tools ?? []).map((t: any) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema
  }));

  return { name, config, client, transport, tools };
}

export async function connectAllServers(mcp: McpJson, baseDir: string): Promise<ConnectedServer[]> {
  const out: ConnectedServer[] = [];
  for (const [name, cfg] of Object.entries(mcp.servers)) {
    out.push(await connectServer(name, cfg, baseDir));
  }
  return out;
}


