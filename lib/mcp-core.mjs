// === Protocol handler (transport-agnostic) ===
export function createProtocolHandler(tools, handlers) {
  const methodMap = new Map([
    ['initialize', m => ({ id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2025-11-25', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'local-mcp', version: '1.1.0' } } })],
    ['tools/list', m => ({ id: m.id, result: { tools } })],
    ['tools/call', m => {
      const h = handlers[m.params?.name];
      if (!h) return { id: m.id, result: { content: [{ type: 'text', text: 'Unknown tool: ' + m.params.name }], isError: true } };
      try {
        const r = h(m.params.arguments || {});
        const wrap = val => ({ id: m.id, result: { content: [{ type: 'text', text: typeof val === 'string' ? val : JSON.stringify(val) }] } });
        if (r && typeof r.then === 'function') return r.then(wrap).catch(e => ({ id: m.id, result: { content: [{ type: 'text', text: e?.message || String(e) }], isError: true } }));
        return wrap(r);
      } catch (e) {
        return { id: m.id, result: { content: [{ type: 'text', text: e?.message || String(e) }], isError: true } };
      }
    }],
    ['resources/list', m => {
      const list = (typeof handlers._resources === 'function') ? handlers._resources() : (handlers._resources || []);
      return { id: m.id, result: { resources: list } };
    }],
    ['resources/read', m => {
      const uri = m.params?.uri;
      if (!uri) return { id: m.id, result: { content: [], isError: true } };
      if (typeof handlers._readResource !== 'function') return { id: m.id, result: { contents: [] } };
      try {
        const r = handlers._readResource(uri);
        const wrap = val => ({ id: m.id, result: { contents: Array.isArray(val) ? val : [val] } });
        if (r && typeof r.then === 'function') return r.then(wrap).catch(e => ({ id: m.id, result: { content: [{ type: 'text', text: e?.message || String(e) }], isError: true } }));
        return wrap(r);
      } catch (e) {
        return { id: m.id, result: { content: [{ type: 'text', text: e?.message || String(e) }], isError: true } };
      }
    }],
    ['ping', m => ({ id: m.id, result: {} })],
    ['resources/templates/list', m => {
      const list = (typeof handlers._resourceTemplates === 'function') ? handlers._resourceTemplates() : (handlers._resourceTemplates || []);
      return { id: m.id, result: { resourceTemplates: list } };
    }]
  ]);

  return {
    handleMessage(m) {
      if (m.id == null) return null;
      const fn = methodMap.get(m.method);
      return fn ? fn(m) : null;
    }
  };
}

// === Stdio transport (MCP Content-Length framing) ===
export function serve(tools, handlers) {
  const proto = createProtocolHandler(tools, handlers);

  let buf = '';
  let contentLength = -1;

  process.stdin.on('data', chunk => {
    buf += chunk.toString('utf-8');
    processBuf();
  });

  function processBuf() {
    while (true) {
      if (contentLength === -1) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return; // header not complete yet
        const header = buf.slice(0, idx);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          // malformed header — discard up to next \n
          const nl = buf.indexOf('\n');
          buf = nl === -1 ? '' : buf.slice(nl + 1);
          continue;
        }
        contentLength = parseInt(match[1], 10);
        buf = buf.slice(idx + 4); // skip past \r\n\r\n
      }

      // Consume exactly contentLength bytes via Buffer (handles multi-byte UTF-8)
      const encoded = Buffer.from(buf, 'utf-8');
      if (encoded.length < contentLength) return; // wait for more data
      const body = encoded.slice(0, contentLength).toString('utf-8');
      buf = encoded.slice(contentLength).toString('utf-8');
      contentLength = -1;

      try {
        const msg = JSON.parse(body);
        const result = proto.handleMessage(msg);
        if (!result) continue;
        if (result instanceof Promise) {
          result.then(r => send(r.id, r.result)).catch(() => {});
        } else {
          send(result.id, result.result);
        }
      } catch {}
    }
  }

  function send(id, result) {
    const body = JSON.stringify({ jsonrpc: '2.0', id, result });
    const len = Buffer.byteLength(body, 'utf-8');
    process.stdout.write(`Content-Length: ${len}\r\nContent-Type: application/json\r\n\r\n${body}`);
  }
}

// === HTTP transport (Streamable HTTP, MCP 2025-03-26) ===
import http from 'http';

export function serveHttp(tools, handlers, port = 3100) {
  const proto = createProtocolHandler(tools, handlers);

  const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // GET /health or GET / for simple checks
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, server: 'local-mcp', transport: 'streamable-http' }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    const accept = req.headers['accept'] || '';
    const wantsStream = accept.includes('text/event-stream');

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }));
        return;
      }

      const result = proto.handleMessage(msg);

      if (result instanceof Promise) {
        if (wantsStream) {
          // SSE streaming
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });
          result.then(r => {
            res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: r.id, result: r.result })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          }).catch(() => { res.end(); });
        } else {
          // Wait for promise, return JSON
          result.then(r => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: r.result }));
          }).catch(() => {
            res.writeHead(500);
            res.end();
          });
        }
      } else if (result) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: result.id, result: result.result }));
      } else {
        res.writeHead(204);
        res.end();
      }
    });
  });

  server.listen(port, '0.0.0.0', () => {
    process.stderr.write(`MCP HTTP server listening on http://0.0.0.0:${port}\n`);
  });

  // Graceful shutdown
  function shutdown() {
    try { server.closeAllConnections?.(); server.close(); } catch {}
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}