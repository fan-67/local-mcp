import { join } from 'path';
import { homedir } from 'os';

// 所有路径通过环境变量配置，默认值使用当前目录
export const WORKSPACE = process.env.MCP_WORKSPACE || process.cwd();
export const DATA = process.env.MCP_DATA || join(WORKSPACE, '.mcp-data');
export const MCP_DIR = process.env.MCP_DIR || WORKSPACE;
export const TEMP = join(DATA, 'temp');
export const BOOKMARK_FILE = join(DATA, 'bookmarks.json');
export const SCREENSHOT_DIR = join(DATA, 'screenshots');
export const PDF_DIR = join(DATA, 'pdfs');
export const COOKIE_DIR = TEMP;
