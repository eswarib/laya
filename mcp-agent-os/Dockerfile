FROM node:20-slim

# Keep runtime lean-ish, but include what we need for basic tooling.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/mcp-agent-os

# Install deps with good layer caching: copy only manifests first.
COPY package.json package-lock.json tsconfig.base.json ./
COPY client/package.json client/package.json
COPY servers/browser-server/package.json servers/browser-server/package.json
COPY servers/ide-server/package.json servers/ide-server/package.json
COPY servers/terminal-server/package.json servers/terminal-server/package.json

RUN npm ci

# Now copy the rest of the workspace.
COPY . .

# Container-friendly defaults:
# - sandbox root is /workspace (mount a volume there)
# - use docker terminal policy (still overrideable via TERMINAL_POLICY_PATH)
ENV TERMINAL_POLICY_PATH=/app/mcp-agent-os/servers/terminal-server/terminal-policy.docker.json

# Create a writable sandbox root.
RUN mkdir -p /workspace

# Run the launcher (starts the client; will attempt to connect to Ollama).
CMD ["node", "bin/laya.js"]


