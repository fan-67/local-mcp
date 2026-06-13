import { join } from 'path';

// All paths via env vars, defaults to current dir
export const WORKSPACE = process.env.MCP_WORKSPACE || process.cwd();
export const DATA = process.env.MCP_DATA || join(WORKSPACE, '.mcp-data');
export const BOOKMARK_FILE = join(DATA, 'bookmarks.json');
export const MCP_DIR = process.env.MCP_DIR || WORKSPACE;
