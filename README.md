# local-mcp

A lightweight, stdio-based **MCP** (Model Context Protocol) server for local file system operations. Designed to run as a subprocess for AI assistants (Claude, Cursor, Chatbox, etc.) that support the MCP protocol.

## Features

- **Read/Write/Edit** files with cache (FIFO, max 10) & atomic writes (temp + rename); head+tail simultaneous reading shows start/end with omitted middle
- **Search** files with smart scoring (glob → grep fallback)
- **Move/Rename** files and directories
- **List** directories with iterative tree view (stack-safe, no recursion)
- **Execute** shell commands (bat bypass for Windows, b64 mode for complex commands)
- **Batch** operations with atomic rollback & `$prev` result referencing
- **Block-level** code manipulation (by function name or line range, with dry-run)
- **Bookmark** system for path aliases (in-memory cache, persisted to JSON)

All tool parameters include descriptions to help AI assistants call them correctly — no more guessing.

## Available Tools

| Tool | Description |
|------|-------------|
| `read` | Read file, optional head/tail line limit (both = head + `...` + tail) |
| `search` | File search by name (glob) or content (grep), exclude/ext filter |
| `ls` | List directory; tree view (`depth=N`), sort by size, full metadata |
| `exec` | Execute shell command; timeout, cwd, base64-encoded cmd modes |
| `move` | Move or rename file/directory |
| `batch` | Run multiple ops sequentially; atomic rollback, `$prev` result refs |
| `file` | Unified: read, write, edit, append, delete, info, mkdir, move |
| `block` | Read/replace/insert/delete code blocks by line range or function name |
| `bookmark` | Persistent path aliases (add/get/list/delete) |

## Installation

```bash
npm install
```

## Usage

### As an MCP server

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

### Configuration via environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_WORKSPACE` | `process.cwd()` | Working directory root |
| `MCP_DATA` | `{WORKSPACE}/.mcp-data` | Data directory (bookmarks, temp files) |
| `MCP_DIR` | `{WORKSPACE}` | Default directory for tree/ls commands |

## Security

- All file operations are restricted to `MCP_WORKSPACE` and its subdirectories
- Shell execution writes to a temp file and immediately deletes it
- Bookmark data stored in `MCP_DATA`

## Optimizations

| Area | Detail |
|------|--------|
| **Code size** | ~16 KB, deduplicated temp-file write / cache patterns into shared helpers |
| **Parameter docs** | All 9 tools × 50 parameter descriptions — AI assistants know exactly what to pass |
| **Tree view** | Iterative (stack-based) instead of recursive — safe for deep directory trees |
| **Search** | Cross-platform pure-JS grep (no Windows `findstr` dependency) |
| **Cache** | Read cache with mtime invalidation, FIFO eviction at 10 entries |
| **Bookmarks** | In-memory cache avoids redundant disk reads on every lookup |
| **Edit** | Exact match fast-path + fuzzy line-trim fallback, minimal normalization passes |

## Dependencies

- `glob` — file pattern matching
- `diff` — unified diff generation

Only **2 runtime dependencies**, no frameworks. Total install size ~6 MB.

## License

MIT
