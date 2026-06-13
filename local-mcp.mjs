import { serve, serveHttp, createProtocolHandler } from './lib/mcp-core.mjs';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync, renameSync, watch as fsWatch, globSync, openSync, readSync, closeSync, createReadStream } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { resolve, join } from 'path';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { WORKSPACE, DATA, BOOKMARK_FILE, MCP_DIR } from './lib/config.mjs';

// === Exported for testing ===
export { createProtocolHandler as _createProtocolHandler };

// === Read-only mode ===
const READONLY = process.env.MCP_READONLY === 'true' || process.env.MCP_READONLY === '1';
function checkReadonly() {
  if (READONLY) throw err('READONLY_MODE', 'Write operations are disabled (MCP_READONLY=true)');
}

const ALLOW = [resolve(WORKSPACE + '/')];
function ok(p) { const f = resolve(p); if (!ALLOW.some(a => f.startsWith(a))) throw err("PERMISSION_DENIED", `Path must be under ${WORKSPACE}/`); return f; }
function err(t, msg) { const e = new Error(msg); e.code = e.type = t; return e; }
export function nl(t) { return (t || '').replace(/\r\n/g, '\n'); }

// === Binary detection: check first 8KB for null byte ===
function isBinary(fp) {
  try {
    const fd = openSync(fp, 'r');
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, 8192, 0);
    closeSync(fd);
    return n > 0 && buf.subarray(0, n).includes(0);
  } catch { return false; }
}

// === Excluded dirs + .gitignore ===
const EXCLUDE_DIRS = ['node_modules', '.git', 'dist', '__pycache__', 'coverage', '.next'];
function isExcluded(p) { return EXCLUDE_DIRS.some(d => p.includes('/' + d + '/') || p.includes('/' + d) || p.startsWith(d + '/') || p === d); }

// Load .gitignore patterns from workspace root
const GITIGNORE_PATTERNS = (() => {
  const patterns = [];
  try {
    const text = readFileSync(join(WORKSPACE, '.gitignore'), 'utf-8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      let p = t;
      let neg = false;
      if (p.startsWith('!')) { neg = true; p = p.slice(1); }
      if (p.startsWith('/')) p = p.slice(1);
      const dirOnly = p.endsWith('/');
      if (dirOnly) p = p.slice(0, -1);
      if (p) patterns.push({ p, neg, dirOnly });
    }
  } catch {}
  return patterns;
})();

function isGitignored(fp) {
  const rel = fp.startsWith(WORKSPACE) ? fp.slice(WORKSPACE.length).replace(/^\//, '') : fp;
  let ignored = false;
  for (const g of GITIGNORE_PATTERNS) {
    // Simple glob match: * matches non-/ chars
    const reStr = '^' + g.p.replace(/\*\*/g, '{{DOUBLESTAR}}').replace(/\*/g, '[^/]*').replace(/{{DOUBLESTAR}}/g, '.*') + (g.dirOnly ? '/.*' : '');
    if (new RegExp(reStr).test(rel)) ignored = !g.neg;
  }
  return ignored;
}

function isSkipped(fp) { return isExcluded(fp) || isGitignored(fp); }

// === Myers' diff (O(N*D) time, O(N+M) space, zero-dep) ===
// Produces same unified diff format as GNU diff -u
function myersEditOps(a, b) {
  // Returns [{ t: 'k'|'i'|'d', l: line }] in forward order
  const n = a.length, m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map(l => ({ t: 'i', l }));
  if (m === 0) return a.map(l => ({ t: 'd', l }));

  const max = n + m;
  const V = new Int32Array(2 * max + 1);
  const trace = [];

  // Forward pass: find minimal edit distance D
  let D;
  for (let d = 0; d <= max; d++) {
    trace.push(new Int32Array(V));
    for (let k = -d; k <= d; k += 2) {
      const idx = k + max;
      let x;
      if (k === -d || (k !== d && V[idx - 1] < V[idx + 1])) {
        x = V[idx + 1]; // from k+1: vertical move (insert from b)
      } else {
        x = V[idx - 1] + 1; // from k-1: horizontal move (delete from a)
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      V[idx] = x;
      if (x === n && y === m) { D = d; break; }
    }
    if (D !== undefined) break;
  }

  // Backtrack through trace to build ops (in reverse)
  const ops = [];
  let x = n, y = m;
  for (let d = D; d > 0; d--) {
    const prevV = trace[d - 1];
    const k = x - y;
    const idx = k + max;

    // Unwind diagonal snake
    while (x > 0 && y > 0 && a[x - 1] === b[y - 1]) {
      ops.push({ t: 'k', l: a[x - 1] });
      x--; y--;
    }

    // Determine which diagonal we came from at depth d-1
    // Must match forward pass rule: k === -d || (k !== d && V[idx-1] < V[idx+1])
    // means came from k+1 (insert), else from k-1 (delete)
    if (k === -d || (k !== d && prevV[idx - 1] < prevV[idx + 1])) {
      // Came from k+1: was an insert from b
      ops.push({ t: 'i', l: b[y - 1] });
      y--;
    } else {
      // Came from k-1: was a delete from a
      ops.push({ t: 'd', l: a[x - 1] });
      x--;
    }
  }
  // Remaining diagonal at d=0
  while (x > 0 && y > 0 && a[x - 1] === b[y - 1]) {
    ops.push({ t: 'k', l: a[x - 1] });
    x--; y--;
  }

  return ops.reverse();
}

function buildUnifiedDiff(a, b, oldName, newName) {
  // Use Myers if total lines < 2000, fall back to simple for large files
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) {
    return buildSimpleDiff(a, b, oldName, newName);
  }
  const ops = myersEditOps(a, b);

  const hasChanges = ops.some(o => o.t !== 'k');
  if (!hasChanges) return `--- ${oldName}\n+++ ${newName}\n`;

  const out = [`--- ${oldName}`, `+++ ${newName}`];
  let ai = 0, bi = 0, pos = 0;

  while (pos < ops.length) {
    // Skip keep ops
    while (pos < ops.length && ops[pos].t === 'k') { pos++; ai++; bi++; }
    if (pos >= ops.length) break;

    // Context before: up to 3 keep ops (all ops before pos are keep ops)
    const ctxBefore = Math.min(3, pos);
    const hunkStart = pos - ctxBefore;
    ai -= ctxBefore;
    bi -= ctxBefore;

    // Find end of hunk: up to 3 context lines after changes
    let ctxAfter = 0, hunkEnd = pos;
    while (hunkEnd < ops.length) {
      if (ops[hunkEnd].t === 'k') { ctxAfter++; if (ctxAfter > 3) break; }
      else ctxAfter = 0;
      hunkEnd++;
    }
    if (ctxAfter > 3) hunkEnd -= (ctxAfter - 3);

    // Calculate hunk header
    let oldLen = 0, newLen = 0;
    for (let k = hunkStart; k < hunkEnd; k++) {
      if (ops[k].t !== 'i') oldLen++;
      if (ops[k].t !== 'd') newLen++;
    }
    out.push(`@@ -${ai + 1},${oldLen} +${bi + 1},${newLen} @@`);

    // Emit hunk lines
    for (let k = hunkStart; k < hunkEnd; k++) {
      const o = ops[k];
      if (o.t === 'k') { out.push(' ' + a[ai]); ai++; bi++; }
      else if (o.t === 'd') { out.push('-' + a[ai]); ai++; }
      else { out.push('+' + b[bi]); bi++; }
    }
    pos = hunkEnd;
  }
  return out.join('\n');
}

function buildSimpleDiff(a, b, oldName, newName) {
  const n = a.length, m = b.length;
  const out = [`--- ${oldName}`, `+++ ${newName}`, `@@ -1,${n} +1,${m} @@`];
  for (let i = 0; i < Math.min(n, m); i++) {
    if (a[i] === b[i]) out.push(' ' + a[i]);
    else { out.push('-' + a[i]); out.push('+' + b[i]); }
  }
  for (let i = Math.min(n, m); i < n; i++) out.push('-' + a[i]);
  for (let i = Math.min(n, m); i < m; i++) out.push('+' + b[i]);
  return out.join('\n');
}

function createTwoFilesPatch(oldName, newName, oldStr, newStr) {
  const a = oldStr.split('\n'), b = newStr.split('\n');
  if (oldStr === newStr) return `--- ${oldName}\n+++ ${newName}\n`;
  return buildUnifiedDiff(a, b, oldName, newName);
}

// === File URI helpers ===
export function fileUriToPath(uri) {
  if (!uri.startsWith('file://')) throw err('INVALID_URI', 'Only file:// URIs are supported');
  const p = decodeURIComponent(uri.slice(7));
  return process.platform === 'win32' ? p.replace(/^\/([a-zA-Z]):\//, '$1:\\') : p;
}
export function pathToFileUri(p) {
  const abs = resolve(p);
  return 'file://' + (process.platform === 'win32' ? '/' + abs.replace(/\\/g, '/') : abs);
}

// === Watch state ===
const watchers = new Map();
let watchEventId = 0;

// === Iterative directory tree (stack-safe, no recursion) ===
export function treeDir(root, maxDepth) {
  const parts = [];
  const stack = [{ dir: root, pre: '', depth: 0 }];
  while (stack.length) {
    const { dir, pre, depth } = stack.pop();
    if (depth >= maxDepth) { parts.push(pre + '...\n'); continue; }
    const items = readdirSync(dir, { withFileTypes: true });
    const children = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i];
      const last = i === items.length - 1;
      parts.push(pre + (last ? '└── ' : '├── ') + entry.name + '\n');
      if (entry.isDirectory()) children.push({ dir: join(dir, entry.name), pre: pre + (last ? '    ' : '│   '), depth: depth + 1 });
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return parts.join('');
}

// === Read cache + atomic write (size-aware eviction) ===
const readCache = new Map();
const CACHE_MAX_ITEMS = 50;
const CACHE_MAX_BYTES = 10 * 1024 * 1024;
let cacheBytes = 0;

function evictCache() {
  while (readCache.size > CACHE_MAX_ITEMS || (cacheBytes > CACHE_MAX_BYTES && readCache.size > 1)) {
    // Evict largest entry to reclaim most bytes per eviction
    let maxKey, maxSize = -1;
    for (const [k, v] of readCache) {
      if (v.size > maxSize) { maxSize = v.size; maxKey = k; }
    }
    if (maxKey) { cacheBytes -= readCache.get(maxKey).size; readCache.delete(maxKey); }
  }
}

function cachedRead(f) {
  const st = statSync(f);
  const entry = readCache.get(f);
  if (entry && entry.mtime === st.mtimeMs) return entry.content;
  const content = readFileSync(f, 'utf-8');
  readCache.set(f, { content, mtime: st.mtimeMs, size: st.size });
  cacheBytes += st.size;
  if (readCache.size > CACHE_MAX_ITEMS || cacheBytes > CACHE_MAX_BYTES) evictCache();
  return content;
}
function invalidateCache(f) { const e = readCache.get(f); if (e) { cacheBytes -= e.size; readCache.delete(f); } }
function updateCache(f) {
  try {
    const content = readFileSync(f, 'utf-8');
    const st = statSync(f);
    const old = readCache.get(f);
    if (old) cacheBytes -= old.size;
    readCache.set(f, { content, mtime: st.mtimeMs, size: st.size });
    cacheBytes += st.size;
  } catch {}
}
function atomicWrite(f, content) {
  const tmp = f + '.tmp.' + Date.now();
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, f);
  invalidateCache(f);
}

export function compactDiff(diff) {
  const lines = diff.split('\n');
  let add = 0, del = 0;
  for (const l of lines) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++;
    else if (l.startsWith('-') && !l.startsWith('---')) del++;
  }
  return `+${add}/-${del} lines`;
}

export function scoreResults(results, query) {
  const q = query.toLowerCase();
  return results.map(r => {
    let s = 0;
    const n = r.split('/').pop().toLowerCase();
    if (n === q) s += 20;
    else if (n.includes(q)) s += 10;
    else for (let i = 0; i < q.length && i < n.length; i++) if (n[i] === q[i]) s += 2;
    s -= r.split('/').length;
    try { const st = statSync(join(WORKSPACE, r)); const age = Date.now() - st.mtimeMs; if (age < 3600000) s += 5; else if (age < 86400000) s += 3; else if (age < 604800000) s += 1; } catch {}
    return { r, s };
  }).sort((a, b) => b.s - a.s).map(x => x.r);
}

const tools = [
  { name: 'read', description: 'Read file (head/tail to limit lines; both together shows head + ... + tail)', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to file' }, head: { type: 'number', description: 'Number of lines from start' }, tail: { type: 'number', description: 'Number of lines from end' } }, required: ['path'] } },
  { name: 'search', description: 'Search files by name or content (glob then grep)', inputSchema: { type: 'object', properties: { p: { type: 'string', description: 'Search pattern (filename or path fragment)' }, exclude: { type: 'string', description: 'Glob pattern to exclude (e.g. node_modules/**)' }, ext: { type: 'string', description: 'File extension filter (e.g. .mjs .js)' } }, required: ['p'] } },
  { name: 'ls', description: 'List directory contents', inputSchema: { type: 'object', properties: { p: { type: 'string', description: 'Directory path' }, sort: { type: 'string', description: 'Sort order: size' }, tree: { type: 'boolean', description: 'Show tree view' }, depth: { type: 'number', description: 'Tree depth (default 2)' }, detail: { type: 'boolean', description: 'Show full metadata' } } } },
  { name: 'exec', description: 'Execute shell command', inputSchema: { type: 'object', properties: { cmd: { type: 'string', description: 'Command string' }, args: { type: 'array', items: { type: 'string' }, description: 'Command as args array' }, cwd: { type: 'string', description: 'Working directory' }, t: { type: 'number', description: 'Timeout in seconds (default 30)' }, b64: { type: 'boolean', description: 'Base64 decode cmd before execution' } } } },
  { name: 'move', description: 'Move or rename file/directory', inputSchema: { type: 'object', properties: { source: { type: 'string', description: 'Source path' }, destination: { type: 'string', description: 'Destination path' } }, required: ['source', 'destination'] } },
  { name: 'batch', description: 'Batch multiple operations with rollback', inputSchema: { type: 'object', properties: { ops: { type: 'array', items: { type: 'object' }, description: 'Array of operations' }, stopOnError: { type: 'boolean', description: 'Stop on first error (default true)' }, atomic: { type: 'boolean', description: 'Rollback all on failure' } }, required: ['ops'] } },
  { name: 'file', description: 'Unified file operations (action=read|write|edit|append|delete|info|mkdir|move)', inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'Operation: read|write|edit|append|delete|info|mkdir|move' }, path: { type: 'string', description: 'Target file path' }, content: { type: 'string', description: 'File content (for write)' }, old: { type: 'string', description: 'Text to replace (for edit)' }, new: { type: 'string', description: 'Replacement text (for edit)' }, destination: { type: 'string', description: 'Destination path (for move)' }, head: { type: 'number', description: 'Lines from start (for read)' }, tail: { type: 'number', description: 'Lines from end (for read)' }, dryRun: { type: 'boolean', description: 'Preview changes without applying' } }, required: ['action', 'path'] } },
  { name: 'block', description: 'Code block operations by range or function name', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File path' }, action: { type: 'string', description: 'read|replace|insert|delete' }, range: { type: 'object', properties: { start: { type: 'number', description: 'Start line (1-based)' }, end: { type: 'number', description: 'End line (1-based)' } }, description: 'Line range' }, name: { type: 'string', description: 'Function name to locate' }, content: { type: 'string', description: 'New content' }, dryRun: { type: 'boolean', description: 'Preview diff only' } }, required: ['path', 'action'] } },
  { name: 'bookmark', description: 'Persistent path aliases', inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'add|get|list|delete' }, name: { type: 'string', description: 'Bookmark name' }, path: { type: 'string', description: 'Path to bookmark' } }, required: ['action'] } },
  { name: 'watch', description: 'Watch file/directory for changes (event-driven, returns new events since last call)', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path to file or directory to watch' }, once: { type: 'boolean', description: 'If true, returns current state and stops watching' } }, required: ['path'] } }
];

export function applyEdit(content, oldText, newText) {
  const nOld = nl(oldText);
  const nNew = nl(newText || '');
  // Exact match (fast path)
  const idx = content.indexOf(nOld);
  if (idx !== -1) return content.slice(0, idx) + nNew + content.slice(idx + nOld.length);
  // Trim-match each line (fuzzy path)
  const oldLines = nOld.split('\n');
  const cLines = content.split('\n');
  const limit = cLines.length - oldLines.length;
  for (let i = 0; i <= limit; i++) {
    const match = cLines.slice(i, i + oldLines.length);
    if (oldLines.every((l, j) => l.trim() === match[j].trim())) {
      const newLines = nNew.split('\n').map((line, j) => {
        const adj = (match[j].match(/^\s*/)?.[0] || '').length - (oldLines[j].match(/^\s*/)?.[0] || '').length;
        return adj ? ' '.repeat(Math.max(0, adj)) + line.trimStart() : line;
      });
      cLines.splice(i, oldLines.length, ...newLines);
      return cLines.join('\n');
    }
  }
  throw err("MATCH_NOT_FOUND", "Match not found: " + (oldText || '').slice(0, 50));
}

export function findBlock(lines, name) {
  const re = new RegExp('(?:function|const|let|var|async)\\s+' + name + '\\b|' + name + '\\s*[:=]\\s*(?:async\\s+)?[(\\(]|' + name + '\\s*[:=]\\s*(?:async\\s+)?\\w+\\s*=>');
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      let depth = 0, start = i;
      if (!lines[i].includes('{')) {
        for (let j = i + 1; j < lines.length && j < i + 5; j++) {
          if (lines[j].includes('{')) { start = j; break; }
        }
      }
      for (let j = start; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) return { start, end: j }; }
        }
      }
      return { start, end: lines.length - 1 };
    }
  }
  return null;
}

async function runGrep(s, ext) {
  const exts = ext ? ext.split(/\s+/).filter(Boolean) : ['.mjs', '.js'];
  const q = s.toLowerCase();

  // Collect all eligible files
  const allFiles = [];
  for (const e of exts) {
    const pat = e.startsWith('.') ? `**/*${e}` : `**/*.${e}`;
    const files = globSync(pat, { cwd: WORKSPACE, exclude: isSkipped });
    for (const f of files) {
      if (!isBinary(join(WORKSPACE, f))) allFiles.push(f);
    }
  }

  // Process with bounded concurrency
  const CONCURRENCY = 16;
  let idx = 0;

  async function worker() {
    const local = [];
    while (idx < allFiles.length) {
      const f = allFiles[idx++];
      try {
        const rl = createInterface({ input: createReadStream(join(WORKSPACE, f), 'utf-8'), crlfDelay: Infinity });
        let ln = 0;
        for await (const line of rl) {
          ln++;
          if (line.toLowerCase().includes(q)) local.push(`${f}:${ln}`);
        }
      } catch {}
    }
    return local;
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, allFiles.length || 1) }, () => worker());
  const nested = await Promise.all(workers);
  return nested.flat();
}

// === In-memory bookmark cache ===
let _bookmarkCache = null;
function loadBookmarks() {
  if (_bookmarkCache) return _bookmarkCache;
  try { _bookmarkCache = JSON.parse(readFileSync(BOOKMARK_FILE, 'utf-8')); } catch { _bookmarkCache = {}; }
  return _bookmarkCache;
}
function saveBookmarks(bm) { _bookmarkCache = bm; atomicWrite(BOOKMARK_FILE, JSON.stringify(bm)); }

const h = {
  read: p => {
    const f = ok(p.path);
    let c = cachedRead(f);
    const lines = c.split('\n');
    if (p.head && p.tail) {
      if (p.head + p.tail >= lines.length) return c;
      return lines.slice(0, p.head).join('\n') + `\n... (${lines.length - p.head - p.tail} lines omitted) ...\n` + lines.slice(-p.tail).join('\n');
    }
    if (p.head) return lines.slice(0, p.head).join('\n');
    if (p.tail) return lines.slice(-p.tail).join('\n');
    return c;
  },
  write: p => { checkReadonly(); atomicWrite(ok(p.path), p.content); updateCache(ok(p.path)); return 'ok'; },
  edit: p => {
    checkReadonly();
    const f = ok(p.path);
    const nc = nl(readFileSync(f, 'utf-8'));
    const modified = applyEdit(nc, p.old, p.new);
    const diff = createTwoFilesPatch(p.path, p.path, nc, modified, 'old', 'new');
    if (p.dryRun) return compactDiff(diff);
    atomicWrite(f, modified.replace(/\n/g, '\r\n'));
    updateCache(f);
    return compactDiff(diff);
  },
  append: p => { checkReadonly(); writeFileSync(ok(p.path), p.content, { encoding: 'utf-8', flag: 'a' }); invalidateCache(ok(p.path)); return 'ok'; },
  move: p => { checkReadonly(); renameSync(ok(p.source), ok(p.destination)); invalidateCache(ok(p.source)); return 'ok'; },
  search: async p => {
    const pats = [p.p, `**/*${p.p}*`, `**/*${p.p.replace(/[/\\]/g, '')}*`];
    for (const pat of pats) {
      const results = globSync(pat, { cwd: WORKSPACE, exclude: isSkipped });
      if (results.length) return scoreResults(results, p.p);
    }
    if (!p.exclude) {
      const found = await runGrep(p.p, p.ext || '.mjs .js');
      if (found.length) return scoreResults(found, p.p);
    }
    return [];
  },
  grep: p => runGrep(p.s, p.ext),
  ls: p => {
    if (p.tree) return (p.p || 'MCP') + '/\n' + treeDir(ok(p.p || MCP_DIR), p.depth || 2);
    const d = ok(p.p || DATA);
    const items = readdirSync(d, { withFileTypes: true }).map(e => ({ n: e.name, d: e.isDirectory(), s: e.isFile() ? statSync(join(d, e.name)).size : 0 }));
    if (p.sort === 'size') items.sort((a, b) => b.s - a.s);
    if (p.detail) return items;
    const files = items.filter(i => !i.d).length;
    const dirs = items.filter(i => i.d).length;
    const total = items.reduce((a, i) => a + i.s, 0);
    const kb = total > 1024 ? (total / 1024).toFixed(1) + 'KB' : total + 'B';
    return `${files} files, ${dirs} dirs (${kb})`;
  },
  // exec: bat workaround — Chatbox CVE-2026-6130 blocks top-level cmd params
  // write cmd to run.bat → spawnSync → delete immediately
  // b64: base64 → PowerShell decode, bypass cmd escaping; batch embedded exec unaffected
  // ⚠️ keep taskkill — zombie processes linger on timeout
  exec: p => {
    checkReadonly();
    const cmd = p.args ? p.args.join(' ') : (p.cmd || '');
    if (!cmd) return '';
    const cwd = p.cwd || DATA;
    const t = (p.t || 30) * 1000;
    const batDir = join(DATA, 'temp');
    mkdirSync(batDir, { recursive: true });
    const bat = join(batDir, 'run.bat');
    const prolog = '@echo off\r\nchcp 65001 >nul\r\n';
    const batContent = p.b64
      ? prolog + 'powershell -NoProfile -Command "$c=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(\'' + Buffer.from(cmd, 'utf-8').toString('base64') + '\')); cmd /c $c; exit $LASTEXITCODE"\r\n'
      : prolog + cmd + '\r\n';
    writeFileSync(bat, batContent);
    const child = spawnSync('cmd', ['/c', bat], { encoding: 'utf-8', cwd, timeout: t, maxBuffer: 10 * 1024 * 1024 });
    rmSync(bat, { force: true });
    if (child.error) {
      if (child.pid) try { execSync(`taskkill /F /T /PID ${child.pid} 2>nul`, { timeout: 5000 }); } catch {}
      return (child.stderr || child.stdout || child.error.message || '').toString().trim();
    }
    return (child.stdout || '').trim();
  },
  batch: p => {
    checkReadonly();
    const results = [];
    let prev = null;
    const backups = new Map();
    if (p.atomic) {
      for (const o of p.ops) {
        const fp = o.path;
        if (fp && /^(edit|write|file|block|delete)$/.test(o.op || '') && !backups.has(fp)) {
          try { backups.set(fp, readFileSync(fp, 'utf-8')); } catch {}
        }
      }
    }
    for (const o of p.ops) {
      const op = { ...o };
      for (const [k, v] of Object.entries(op)) {
        if (typeof v === 'string' && v.includes('$prev')) op[k] = v.replace(/\$prev/g, prev ?? '');
      }
      try {
        if (!h[op.op]) throw new Error('Unknown operation: ' + op.op);
        prev = h[op.op](op);
        results.push({ ok: true, op: op.op, r: prev });
      } catch (e) {
        results.push({ ok: false, op: op.op, e: e.message });
        if (p.atomic) {
          for (const [fp, content] of backups) try { writeFileSync(fp, content, 'utf-8'); } catch {}
          results.push({ atomicRollback: true, files: [...backups.keys()] });
        }
        if (p.stopOnError !== false) break;
      }
    }
    return results;
  },
  file: p => {
    switch (p.action) {
      case 'read': return h.read(p);
      case 'write': checkReadonly(); return h.write(p);
      case 'edit': checkReadonly(); return h.edit(p);
      case 'append': checkReadonly(); return h.append(p);
      case 'move': return h.move({ source: p.path, destination: p.destination });
      case 'mkdir': checkReadonly(); mkdirSync(ok(p.path), { recursive: true }); return 'ok';
      case 'delete': checkReadonly(); rmSync(ok(p.path), { recursive: true, force: true }); return 'ok';
      case 'info': {
        const s = statSync(ok(p.path));
        return { size: s.size, mtime: s.mtime.toISOString(), isDir: s.isDirectory(), isFile: s.isFile() };
      }
      default: throw err("INVALID_ACTION", "action: read|write|edit|append|delete|move|info|mkdir");
    }
  },
  block: p => {
    const f = ok(p.path);
    const nc = nl(readFileSync(f, 'utf-8'));
    const lines = nc.split('\n');
    let rStart, rEnd;
    if (p.range) { rStart = p.range.start - 1; rEnd = (p.range.end || p.range.start) - 1; }
    if (p.name) {
      const blk = findBlock(lines, p.name);
      if (!blk) throw err("NAME_NOT_FOUND", "Not found: " + p.name);
      rStart = rStart != null ? Math.max(rStart, blk.start) : blk.start;
      rEnd = rEnd != null ? Math.min(rEnd, blk.end) : blk.end;
    }
    if (rStart == null) throw err("MISSING_PARAM", "Need range or name parameter");
    if (rStart < 0 || rEnd >= lines.length) throw err("OUT_OF_RANGE", `Line range out of bounds: ${rStart + 1}-${rEnd + 1} (file has ${lines.length} lines)`);
    const act = p.action;
    if (act === 'read') return lines.slice(rStart, rEnd + 1).join('\n');
    if (['replace', 'insert', 'delete'].includes(act)) checkReadonly();
    const before = lines.slice(0, rStart).join('\n');
    const after = lines.slice(rEnd + 1).join('\n');
    const blockStr = lines.slice(rStart, rEnd + 1).join('\n');
    let modified;
    if (act === 'replace' || act === 'insert') {
      const ct = p.content || '';
      modified = act === 'replace'
        ? (before + (before ? '\n' : '') + ct + (after ? '\n' : '') + after)
        : (before + (before ? '\n' : '') + ct + '\n' + blockStr + (after ? '\n' : '') + after);
    } else if (act === 'delete') {
      modified = before + (after ? '\n' : '') + after;
    } else throw err("INVALID_ACTION", "action: read|replace|insert|delete");
    const diff = createTwoFilesPatch(p.path, p.path, nc, modified, 'old', 'new');
    if (p.dryRun) return compactDiff(diff);
    atomicWrite(f, modified.replace(/\n/g, '\r\n'));
    updateCache(f);
    return compactDiff(diff);
  },
  bookmark: p => {
    const bm = loadBookmarks();
    switch (p.action) {
      case 'add':
        checkReadonly();
        if (!p.name || !p.path) throw err("MISSING_PARAM", "Need name and path");
        bm[p.name] = ok(p.path); saveBookmarks(bm); return 'ok';
      case 'get':
        if (!p.name) throw err("MISSING_PARAM", "Need name");
        return bm[p.name] || null;
      case 'list': return bm;
      case 'delete':
        checkReadonly();
        if (!p.name) throw err("MISSING_PARAM", "Need name");
        delete bm[p.name]; saveBookmarks(bm); return 'ok';
      default: throw err("INVALID_ACTION", "action: add|get|list|delete");
    }
  },
  watch: p => {
    const target = ok(p.path);
    const stat = statSync(target);
    const key = resolve(target);

    if (p.once) {
      // Return current state and stop watching
      if (watchers.has(key)) {
        const entry = watchers.get(key);
        entry.w.close();
        watchers.delete(key);
      }
      return { watched: key, isDir: stat.isDirectory(), stopped: true };
    }

    // Start watching if not already
    if (!watchers.has(key)) {
      const events = [];
      const w = fsWatch(target, { recursive: stat.isDirectory() }, (eventType, filename) => {
        events.push({ id: ++watchEventId, type: eventType, file: filename || '', time: new Date().toISOString() });
      });
      watchers.set(key, { w, events, isDir: stat.isDirectory() });
      return { watched: key, isDir: stat.isDirectory(), started: true, events: [] };
    }

    // Return accumulated events
    const w = watchers.get(key);
    const evts = w.events.splice(0);
    return { watched: key, isDir: w.isDir, events: evts };
  }
};

// === Resource support ===
export function listResources() {
  return [
    { uri: pathToFileUri(WORKSPACE), name: 'Workspace root', description: `Workspace directory: ${WORKSPACE}`, mimeType: 'inode/directory' }
  ];
}

export function readResource(uri) {
  const p = fileUriToPath(uri);
  const resolved = ok(p);
  const s = statSync(resolved);
  if (s.isDirectory()) {
    const items = readdirSync(resolved);
    return { uri, mimeType: 'inode/directory', text: JSON.stringify(items) };
  }
  if (isBinary(resolved)) return { uri, mimeType: 'application/octet-stream', text: '[binary file]' };
  const text = readFileSync(resolved, 'utf-8');
  const mimeType = resolved.endsWith('.json') ? 'application/json'
    : resolved.endsWith('.md') ? 'text/markdown'
    : resolved.endsWith('.mjs') || resolved.endsWith('.js') ? 'text/javascript'
    : 'text/plain';
  return { uri, mimeType, text };
}

h._resources = listResources;
h._readResource = readResource;

// === CLI ===
// Only start server when run directly, not when imported for testing
const isMain = (() => {
  if (!process.argv[1]) return false;
  const meta = resolve(fileURLToPath(import.meta.url));
  const arg = resolve(process.argv[1]);
  return meta === arg;
})();
if (isMain) {
  const args = process.argv.slice(2);
  const httpMode = args.includes('--http');
  const httpPort = (() => {
    const idx = args.indexOf('--port');
    if (idx !== -1 && idx + 1 < args.length) return parseInt(args[idx + 1], 10);
    return parseInt(process.env.MCP_PORT || '3100', 10);
  })();

  if (httpMode) {
    serveHttp(tools, h, httpPort);
  } else {
    serve(tools, h);
  }
}
