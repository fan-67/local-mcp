import { createInterface } from 'readline';
export function serve(tools, handlers) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let buf = '';
  rl.on('line', l => {
    buf += l;
    try { const m = JSON.parse(buf); buf = ''; handle(m); } catch {}
  });
  function handle(m) {
    if (m.method === 'initialize' && m.id != null)
      send(m.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mcp', version: '1.0.0' } });
    else if (m.method === 'tools/list' && m.id != null) send(m.id, { tools });
    else if (m.method === 'tools/call' && m.id != null) {
      const h = handlers[m.params.name];
      if (!h) return send(m.id, { content: [{ type: 'text', text: '未知工具' + m.params.name }], isError: true });
      Promise.resolve().then(() => h(m.params.arguments || {}))
        .then(r => send(m.id, { content: [{ type: 'text', text: JSON.stringify(r) }] }))
        .catch(e => send(m.id, { content: [{ type: 'text', text: e?.message || String(e) }], isError: true }));
    }
  }
  function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
}