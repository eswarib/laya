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

## Configuration (config.json)

You can configure Laya via `config/config.json` (recommended) instead of environment variables.

- Lookup order:
  - `LAYA_CONFIG_PATH` (if set)
  - `./config/config.json` (current working directory)
  - `mcp-agent-os/config/config.json` (next to this README)
  
`config/config.json` is **required**. If it is missing, Laya will exit with an error.

Start by copying:

```bash
cp config/examples/config.example.json config/config.json
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

- `LAYA_CONFIG_PATH`: optional path to config JSON (use this if you don’t want to keep `config/config.json` in the repo).

## Notes

- Server configs live in `mcp.json`.
- Terminal security policy lives in `servers/terminal-server/terminal-policy.json` (override via `TERMINAL_POLICY_PATH`).

## Docker

Build (from `mcp-agent-os/`):

```bash
docker build -t laya-mcp-agent-os .
```

Run with a writable sandbox mounted at `/workspace`:

```bash
docker run --rm -it -v "$PWD:/workspace" laya-mcp-agent-os
```

If your Ollama is running on the host, you usually want to set `OLLAMA_HOST`:

- macOS/Windows Docker Desktop:
  - use `http://host.docker.internal:11434`
- Linux:
  - run with `--add-host host.docker.internal:host-gateway` and use `http://host.docker.internal:11434`

Example:

```bash
docker run --rm -it \
  -v "$PWD:/workspace" \
  --add-host host.docker.internal:host-gateway \
  -e OLLAMA_HOST="http://host.docker.internal:11434" \
  laya-mcp-agent-os
```

The Docker image uses a container-friendly terminal policy by default:
`servers/terminal-server/terminal-policy.docker.json` (sandboxRoot=`/workspace`).



