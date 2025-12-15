# mcp-agent-os

Local MCP “agent OS”:

- **client**: CLI client that reads `mcp.json`, starts servers via stdio, discovers tools, and routes commands.
- **servers/terminal-server**: secure tool server (allowlist + path sandbox + audit log + double confirmation).
- **servers/browser-server**: dummy server (placeholder tools).
- **servers/ide-server**: dummy server (placeholder tools).

## Run

From `mcp-agent-os/`:

```bash
./dev.sh
```

## Chatbot (local Ollama)

This client can run as a chatbot backed by a local model via Ollama.

1) Start Ollama and pull a model:

```bash
ollama serve
ollama pull llama3.2:3b
```

2) Run the client:

```bash
cd mcp-agent-os
OLLAMA_MODEL="llama3.2:3b" npm -w client run dev
```

Or run the launcher (starts `ollama serve` in the background if needed, then runs the client):

```bash
./bin/laya.js
```

Environment variables:

- `OLLAMA_HOST`: default `http://127.0.0.1:11434`
- `OLLAMA_MODEL`: default `llama3`
- `OLLAMA_TIMEOUT_MS`: default `120000`
- `MAX_TOOL_STEPS`: default `10`

## Notes

- Server configs live in `mcp.json`.
- Terminal security policy lives in `servers/terminal-server/terminal-policy.json` (override via `TERMINAL_POLICY_PATH`).



