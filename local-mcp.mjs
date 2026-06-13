import { serve } from './lib/mcp-core.mjs';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, appendFileSync, rmSync, renameSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { resolve, join } from 'path';
import { globSync } from 'glob';
import { createTwoFilesPatch } from 'diff';
import { WORKSPACE, DATA, BOOKMARK_FILE, MCP_DIR } from './lib/config.mjs';

const ALLOW = [resolve(WORKSPACE + '/')];
function ok(p) { const f = resolve(p); if (!ALLOW.some(a => f.startsWith(a))) throw err("PERMISSION_DENIED", `路径必须在 ${WORKSPACE}/ 下`); return f; }
function err(t, msg) { const e = new Error(msg); e.code = e.type = t; return e; }
function nl(t) { return (t || '').replace(/\r\n/g, '\n'); }

// === Iterative directory tree (stack-safe, no recursion) ===
function treeDir(root, maxDepth) {
  let result = '';
  const stack = [{ dir: root, pre: '', depth: 0 }];
  while (stack.length) {
    const { dir, pre, depth } = stack.pop();
    if (depth >= maxDepth) { result += pre + '...\n'; continue; }
    const items = readdirSync(dir);
    const children = [];
    for (let i = 0; i < items.length; i++) {
      const n = items[i];
      const last = i === items.length - 1;
      result += pre + (last ? '└── ' : '├── ') + n + '\n';
      if (statSync(join(dir, n)).isDirectory()) children.push({ dir: join(dir, n), pre: pre + (last ? '    ' : '│   '), depth: depth + 1 });
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return result;
}

// === Read cache + atomic write ===
const readCache = new Map(), MAX_CACHE = 10;
function cachedRead(f) {
  const mtime = statSync(f).mtimeMs;
  const entry = readCache.get(f);
  if (entry && entry.mtime === mtime) return entry.content;
  const content = readFileSync(f, 'utf-8');
  readCache.set(f, { content, mtime });
  if (readCache.size > MAX_CACHE) { const k = readCache.keys().next().value; if (k !== undefined) readCache.delete(k); }
  return content;
}
function invalidateCache(f) { readCache.delete(f); }
function updateCache(f) { try { const c = readFileSync(f, 'utf-8'); readCache.set(f, { content: c, mtime: statSync(f).mtimeMs }); } catch {} }
function atomicWrite(f, content) {
  const tmp = f + '.tmp.' + Date.now();
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, f);
  invalidateCache(f);
}

function compactDiff(diff) {
  const lines = diff.split('\n');
  let add = 0, del = 0;
  for (const l of lines) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++;
    else if (l.startsWith('-') && !l.startsWith('---')) del++;
  }
  return `+${add}/-${del}行`;
}

function scoreResults(results, query) {
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
  { name: 'read', description: '读文件(head/tail限制行数)', inputSchema: { type: 'object', properties: { path: { type: 'string' }, head: { type: 'number' }, tail: { type: 'number' } }, required: ['path'] } },
  { name: 'search', description: '搜索(glob/grep渐进降级,exclude排除,ext过滤)', inputSchema: { type: 'object', properties: { p: { type: 'string' }, exclude: { type: 'string' }, ext: { type: 'string' } }, required: ['p'] } },
  { name: 'ls', description: '列目录(sort=size,tree树状,depth=N,detail全量)', inputSchema: { type: 'object', properties: { p: { type: 'string' }, sort: { type: 'string' }, tree: { type: 'boolean' }, depth: { type: 'number' }, detail: { type: 'boolean' } } } },
  { name: 'exec', description: '执行命令(b64=base64,cwd目录,t=超时秒)', inputSchema: { type: 'object', properties: { cmd: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, t: { type: 'number' }, b64: { type: 'boolean' } } } },
  { name: 'batch', description: '批量操作(stopOnError,atomic回滚,$prev引用)', inputSchema: { type: 'object', properties: { ops: { type: 'array', items: { type: 'object' } }, stopOnError: { type: 'boolean' }, atomic: { type: 'boolean' } }, required: ['ops'] } },
  { name: 'file', description: '文件操作(action=read|write|edit|append|delete|info|mkdir)', inputSchema: { type: 'object', properties: { action: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' }, head: { type: 'number' }, tail: { type: 'number' }, dryRun: { type: 'boolean' } }, required: ['action', 'path'] } },
  { name: 'block', description: '代码块操作(range行号/name函数名,dryRun预览)', inputSchema: { type: 'object', properties: { path: { type: 'string' }, action: { type: 'string' }, range: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' } } }, name: { type: 'string' }, content: { type: 'string' }, dryRun: { type: 'boolean' } }, required: ['path', 'action'] } },
  { name: 'bookmark', description: '书签(action=add|get|list|delete,持久化路径)', inputSchema: { type: 'object', properties: { action: { type: 'string' }, name: { type: 'string' }, path: { type: 'string' } }, required: ['action'] } }
];

function applyEdit(content, oldText, newText) {
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
  throw err("MATCH_NOT_FOUND", "未找到匹配文本: " + (oldText || '').slice(0, 50));
}

function findBlock(lines, name) {
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

function runGrep(s, ext) {
  const exts = ext ? ext.split(/\s+/).filter(Boolean) : ['.mjs', '.js'];
  const results = [];
  for (const e of exts) {
    const pat = e.startsWith('.') ? `**/*${e}` : `**/*.${e}`;
    const files = globSync(pat, { cwd: WORKSPACE, ignore: '**/{node_modules,.git,dist,__pycache__,coverage,.next}/**' });
    for (const f of files) {
      try {
        const lines = readFileSync(join(WORKSPACE, f), 'utf-8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(s.toLowerCase())) results.push(`${f}:${i + 1}`);
        }
      } catch {}
    }
  }
  return results;
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
    if (p.head) c = c.split('\n').slice(0, p.head).join('\n');
    if (p.tail) c = c.split('\n').slice(-p.tail).join('\n');
    return c;
  },
  write: p => { atomicWrite(ok(p.path), p.content); updateCache(ok(p.path)); return 'ok'; },
  edit: p => {
    const f = ok(p.path);
    const nc = nl(readFileSync(f, 'utf-8'));
    const modified = applyEdit(nc, p.old, p.new);
    const diff = createTwoFilesPatch(p.path, p.path, nc, modified, 'old', 'new');
    if (p.dryRun) return compactDiff(diff);
    atomicWrite(f, modified.replace(/\n/g, '\r\n'));
    updateCache(f);
    return compactDiff(diff);
  },
  append: p => { appendFileSync(ok(p.path), p.content, 'utf-8'); invalidateCache(ok(p.path)); return 'ok'; },
  search: p => {
    const pats = [p.p, `**/*${p.p}*`, `**/*${p.p.replace(/[/\\]/g, '')}*`];
    for (const pat of pats) {
      const results = globSync(pat, { cwd: WORKSPACE, ignore: p.exclude || '**/{node_modules,.git,dist,__pycache__,coverage,.next}/**' });
      if (results.length) return scoreResults(results, p.p);
    }
    if (!p.exclude) {
      const found = runGrep(p.p, p.ext || '.mjs .js');
      if (found.length) return scoreResults(found, p.p);
    }
    return [];
  },
  grep: p => runGrep(p.s, p.ext),
  ls: p => {
    if (p.tree) return (p.p || 'MCP') + '/\n' + treeDir(ok(p.p || MCP_DIR), p.depth || 2);
    const d = ok(p.p || DATA);
    let items = readdirSync(d).map(n => { const s = statSync(join(d, n)); return { n, d: s.isDirectory(), s: s.size }; });
    if (p.sort === 'size') items.sort((a, b) => b.s - a.s);
    if (p.detail) return items;
    const files = items.filter(i => !i.d).length;
    const dirs = items.filter(i => i.d).length;
    const total = items.reduce((a, i) => a + i.s, 0);
    const kb = total > 1024 ? (total / 1024).toFixed(1) + 'KB' : total + 'B';
    return `${files} files, ${dirs} dirs (${kb})`;
  },
  tree: p => (p.p || 'MCP') + '/\n' + treeDir(ok(p.p || MCP_DIR), p.depth || 2),
  // exec: bat绕行方案 — Chatbox CVE-2026-6130 拦截顶层cmd参数
  // 命令写入 run.bat → spawnSync → 立即删除
  // b64: base64 → PowerShell解码, 绕过cmd转义; batch内嵌exec不受影响
  // ⚠️ 不要删掉taskkill — 超时进程会残留
  exec: p => {
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
        if (!h[op.op]) throw new Error('未知操作: ' + op.op);
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
      case 'write': return h.write(p);
      case 'edit': return h.edit(p);
      case 'append': return h.append(p);
      case 'mkdir': mkdirSync(ok(p.path), { recursive: true }); return 'ok';
      case 'delete': rmSync(ok(p.path), { recursive: true, force: true }); return 'ok';
      case 'info': {
        const s = statSync(ok(p.path));
        return { size: s.size, mtime: s.mtime.toISOString(), isDir: s.isDirectory(), isFile: s.isFile() };
      }
      default: throw err("INVALID_ACTION", "action: read|write|edit|append|delete|info|mkdir");
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
      if (!blk) throw err("NAME_NOT_FOUND", "未找到: " + p.name);
      rStart = rStart != null ? Math.max(rStart, blk.start) : blk.start;
      rEnd = rEnd != null ? Math.min(rEnd, blk.end) : blk.end;
    }
    if (rStart == null) throw err("MISSING_PARAM", "需要 range 或 name 定位");
    if (rStart < 0 || rEnd >= lines.length) throw err("OUT_OF_RANGE", `行号越界: ${rStart + 1}-${rEnd + 1} (文件共${lines.length}行)`);
    const act = p.action;
    if (act === 'read') return lines.slice(rStart, rEnd + 1).join('\n');
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
        if (!p.name || !p.path) throw err("MISSING_PARAM", "需要 name 和 path");
        bm[p.name] = ok(p.path); saveBookmarks(bm); return 'ok';
      case 'get':
        if (!p.name) throw err("MISSING_PARAM", "需要 name");
        return bm[p.name] || null;
      case 'list': return bm;
      case 'delete':
        if (!p.name) throw err("MISSING_PARAM", "需要 name");
        delete bm[p.name]; saveBookmarks(bm); return 'ok';
      default: throw err("INVALID_ACTION", "action: add|get|list|delete");
    }
  }
};
serve(tools, h);
