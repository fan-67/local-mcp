# local-mcp

A lightweight **MCP** (Model Context Protocol) server for local file system operations. Supports **stdio** (subprocess) and **Streamable HTTP** transport with zero runtime dependencies.

## Features

### Transport: stdio + HTTP
- **stdio** mode (default): run as subprocess for AI assistants (Claude, Cursor, Chatbox, etc.) with MCP Content-Length framing
- **HTTP** mode (`--http`): remote access via MCP Streamable HTTP (2025-03-26 spec), zero additional dependencies
- **CORS** enabled for cross-origin browser access
- **SSE streaming** when `Accept: text/event-stream` header is sent
- **GET /tools** endpoint for quick tool discovery
- Graceful shutdown: `SIGINT`/`SIGTERM` closes connections cleanly

### Progressive Tool Discovery (Search-First Pattern)
Instead of loading all 13 tool schemas into every conversation (~3,000 tokens), the server exposes only 3 meta-tools:

| Tool | Description |
|------|-------------|
| `search_tools` | Search available tools by keyword, returns matching names + descriptions (~50 tokens) |
| `describe_tool` | Get full input schema for a specific tool (loaded on demand) |
| `call_tool` | Execute any tool by name with arguments |

**~90% token savings** compared to flat tool listing. Based on community-validated patterns (Speakeasy: 96% savings, StackOne: ~90%).

### Available Tools (Full Catalog)

| Tool | Description | Annotation |
|------|-------------|------------|
| `read` | Read file with line numbers, optional head/tail truncation | `readOnlyHint` |
| `search` | File search by name (glob) then content (grep) | `readOnlyHint` |
| `ls` | Compact directory listing (name, type, size) | `readOnlyHint` |
| `exec` | Streaming command execution, stdin support, timeout | `destructiveHint` |
| `diff` | Diff two files or text strings (Myers O(ND)) | `readOnlyHint` |
| `copy` | Copy file or directory | `destructiveHint` |
| `move` | Move or rename file/directory | `destructiveHint` |
| `batch` | Run multiple ops sequentially; atomic rollback, `$prev` refs | `destructiveHint` |
| `file` | Unified: read, write, edit, append, delete, info, mkdir, move | — |
| `block` | Read/replace/insert/delete code blocks by range or function | — |
| `bookmark` | Persistent path aliases (add/get/list/delete) | — |
| `grep` | Compact `file:line:content` format (saves ~50% tokens) | `readOnlyHint` |
| `watch` | Watch file/directory for changes; max 20 concurrent watchers | — |

Tool annotations (`readOnlyHint`/`destructiveHint`) follow MCP 2024-11-05 spec — clients can use them for safety decisions.

### Output Format Optimizations
- **grep**: `file:line:content` format — LLM can directly reference line numbers
- **ls**: compact `name.padEnd(16) f/d size` — saves ~60% tokens vs JSON array
- **read**: default head=100 with truncation hint for big files; line numbers prefixed
- **search**: no-match returns guidance ("Try broader query?") instead of negative response

### Resources
- `resources/list` — list accessible resources (workspace root)
- `resources/read` — read file contents via `file://` URIs
- `resources/templates/list` — URI template patterns for workspace files
- MIME type auto-detection (json, markdown, javascript, text, directory)

### Prompts
- `prompts/list` — discover available prompt templates
- `prompts/get` — retrieve prompt by name with arguments

### Read-Only Mode
- Set `MCP_READONLY=true` to block all write operations — safe for code review and browsing

### Security
- All file operations restricted to `MCP_WORKSPACE` and its subdirectories
- Prototype-safe bookmark keys (blocks `__proto__`/`constructor`/`prototype` injection)
- Atomic writes (temp + rename) prevent partial file writes
- Binary file detection prevents reading non-text files
- `.gitignore` and common exclude dirs (`node_modules`, `.git`, etc.) respected
- Configurable `MCP_EXCLUDE` env var for custom exclusion patterns

## Installation

```bash
# Clone or copy, then:
npm install
```

**Zero runtime dependencies.** Only Node.js >= 22 required.

## Usage

### stdio mode (default)
Configure your AI assistant to spawn `local-mcp` as a subprocess:

```json
{
  "mcpServers": {
    "local-mcp": {
      "command": "node",
      "args": ["path/to/local-mcp.mjs"]
    }
  }
}
```

### HTTP mode
```bash
node local-mcp.mjs --http
# or with custom port:
node local-mcp.mjs --http --port 3456
```

The HTTP endpoint accepts JSON-RPC 2.0 POST requests and returns JSON responses. Supports SSE streaming when `Accept: text/event-stream` header is sent. GET `/tools` returns tool list.

### CLI flags
```bash
node local-mcp.mjs --help              # Show usage + env vars
node local-mcp.mjs --list-tools        # Print available tools and exit
node local-mcp.mjs --http              # Start in HTTP mode
node local-mcp.mjs --http --port 3456  # HTTP on custom port
```

Environment variables are printed at startup for self-documentation.

### Configuration via environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_WORKSPACE` | `process.cwd()` | Working directory root |
| `MCP_DATA` | `{WORKSPACE}/.mcp-data` | Data directory (bookmarks, temp files) |
| `MCP_DIR` | `{WORKSPACE}` | Default directory for tree/ls commands |
| `MCP_PORT` | `3100` | HTTP server port (when using `--http`) |
| `MCP_READONLY` | `false` | Set to `true` to block all write operations |
| `MCP_EXCLUDE` | — | Comma-separated extra dirs to exclude from search |

## Dependencies

**Zero runtime dependencies.** Uses only Node.js built-in modules:

| Module | Purpose |
|--------|---------|
| `fs` | File system operations (includes `glob` from Node.js 22) |
| `child_process` | Shell command execution (streaming `spawn`) |
| `http` (built-in) | HTTP transport (no Express/fastify needed) |
| `path` | Path resolution |
| `readline` | Streaming line-by-line processing |

## Optimizations

| Area | Detail |
|------|--------|
| **Code size** | ~830 lines, ~18 KB, zero runtime dependencies |
| **Token efficiency** | Progressive discovery saves ~90% on tools/list; compact grep/ls formats |
| **Read cache** | Size-aware eviction (max 50 items, 10 MB) + 5s TTL for external change detection |
| **Grep** | 16-way parallel readline search, async `fs.glob`, MAX_SEARCH_FILES=5000 guard |
| **Myers diff** | O(ND) algorithm for edit operations, used by `edit`, `block`, and `diff` tool |
| **Tree view** | Iterative (stack-based) instead of recursive — safe for deep trees |
| **Search scoring** | Name-match first (no I/O), then stat only top 50 candidates for mtime bonus |
| **Edit** | Exact match fast-path + fuzzy line-trim fallback |
| **Protocol** | O(1) Map dispatch, sync handler short-circuit |
| **Exec** | Streaming `spawn` with 5000-line truncation, AbortController timeout, stdin pipe |

## Protocol Compatibility

- MCP protocol versions: `2025-11-25` (default), echoes client version if provided
- Transport: stdio (Content-Length framing) + Streamable HTTP
- Methods: `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `resources/templates/list`, `prompts/list`, `prompts/get`, `ping`, `notifications/*`
- Tool annotations: `readOnlyHint` / `destructiveHint` on all tools (MCP 2024-11-05 spec)
- Read-only mode via `MCP_READONLY=true`
- Cross-platform exec (Windows `cmd /c`, Unix `/bin/sh -c`)
- Bookmarks: prototype-safe sanitizeKey (`__proto__`/`constructor`/`prototype` blocked)

## License

MIT
