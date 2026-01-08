# terminal-server

Secure MCP terminal tool server:

- **Allowlist**: only configured commands can run.
- **No raw shell**: uses `spawn(command, args, { shell: false })`.
- **Path sandbox**: file ops and `cwd` are restricted to `sandboxRoot`.
- **Audit log**: JSONL append-only log.
- **Double confirmation**: dangerous commands are blocked until `confirm <token>`.
- **SSH key generation**: `generate_ssh_key` writes to `~/.ssh` but always requires double confirmation.

## Policy

Default: `terminal-policy.json`

Override path:

```bash
export TERMINAL_POLICY_PATH=".../terminal-policy.json"
```

## SSH keys

To generate an SSH keypair under `~/.ssh`, use the tool `generate_ssh_key`.

It is **always** gated by the existing **double-confirm** flow:

- Call `terminal-server.generate_ssh_key` (from the client, the model can call this).
- Then run `confirm <token>` twice to actually execute `ssh-keygen`.

The tool only allows a **filename** (no path separators) and always targets `~/.ssh/<filename>`.




