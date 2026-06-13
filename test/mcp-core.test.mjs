import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProtocolHandler } from '../lib/mcp-core.mjs';

describe('createProtocolHandler', () => {
  const handlers = {
    greet: p => `Hello, ${p.name || 'world'}!`,
    async_hello: async p => `Async hello, ${p.name || 'world'}!`,
    error_tool: () => { throw new Error('Something broke'); }
  };
  const tools = [
    { name: 'greet', description: 'Greet someone', inputSchema: {} },
    { name: 'async_hello', description: 'Async greet', inputSchema: {} },
    { name: 'error_tool', description: 'Always errors', inputSchema: {} }
  ];
  let proto;

  before(() => {
    proto = createProtocolHandler(tools, handlers);
  });

  it('should handle initialize and return capabilities', () => {
    const result = proto.handleMessage({ method: 'initialize', id: 1 });
    assert.equal(result.id, 1);
    assert.equal(result.result.protocolVersion, '2024-11-05');
    assert.equal(result.result.serverInfo.name, 'local-mcp');
    assert.ok(result.result.capabilities.tools);
    assert.ok(result.result.capabilities.resources);
  });

  it('should handle tools/list', () => {
    const result = proto.handleMessage({ method: 'tools/list', id: 2 });
    assert.equal(result.id, 2);
    assert.equal(result.result.tools.length, 3);
    assert.equal(result.result.tools[0].name, 'greet');
  });

  it('should handle tools/call with sync handler', async () => {
    const promise = proto.handleMessage({
      method: 'tools/call', id: 3,
      params: { name: 'greet', arguments: { name: 'Test' } }
    });
    assert.ok(promise instanceof Promise);
    const result = await promise;
    assert.equal(result.id, 3);
    assert.equal(result.result.content[0].text, 'Hello, Test!');
  });

  it('should handle tools/call with async handler', async () => {
    const promise = proto.handleMessage({
      method: 'tools/call', id: 4,
      params: { name: 'async_hello', arguments: { name: 'Async' } }
    });
    const result = await promise;
    assert.equal(result.id, 4);
    assert.equal(result.result.content[0].text, 'Async hello, Async!');
  });

  it('should handle tools/call with unknown tool', async () => {
    const promise = proto.handleMessage({
      method: 'tools/call', id: 5,
      params: { name: 'nonexistent', arguments: {} }
    });
    const result = await promise;
    assert.equal(result.id, 5);
    assert.ok(result.result.isError);
    assert.ok(result.result.content[0].text.includes('Unknown tool'));
  });

  it('should handle tools/call with handler that throws', async () => {
    const promise = proto.handleMessage({
      method: 'tools/call', id: 6,
      params: { name: 'error_tool', arguments: {} }
    });
    const result = await promise;
    assert.equal(result.id, 6);
    assert.ok(result.result.isError);
    assert.ok(result.result.content[0].text.includes('Something broke'));
  });

  it('should handle resources/list', () => {
    handlers._resources = [
      { uri: 'file:///test', name: 'test', mimeType: 'text/plain' }
    ];
    const proto2 = createProtocolHandler(tools, handlers);
    const result = proto2.handleMessage({ method: 'resources/list', id: 7 });
    assert.equal(result.id, 7);
    assert.equal(result.result.resources.length, 1);
    assert.equal(result.result.resources[0].uri, 'file:///test');
  });

  it('should handle resources/list with function handler', () => {
    const customHandlers = {
      _resources: () => [
        { uri: 'file:///func', name: 'func-resource', mimeType: 'text/plain' }
      ]
    };
    const proto2 = createProtocolHandler(tools, customHandlers);
    const result = proto2.handleMessage({ method: 'resources/list', id: 8 });
    assert.equal(result.id, 8);
    assert.equal(result.result.resources[0].uri, 'file:///func');
  });

  it('should handle resources/read with function handler', async () => {
    const customHandlers = {
      _readResource: uri => ({ uri, mimeType: 'text/plain', text: 'content of ' + uri })
    };
    const proto2 = createProtocolHandler(tools, customHandlers);
    const promise = proto2.handleMessage({
      method: 'resources/read', id: 9,
      params: { uri: 'file:///test.txt' }
    });
    const result = await promise;
    assert.equal(result.id, 9);
    assert.equal(result.result.contents.length, 1);
    assert.equal(result.result.contents[0].text, 'content of file:///test.txt');
  });

  it('should handle resources/read with missing uri', async () => {
    const promise = proto.handleMessage({
      method: 'resources/read', id: 10,
      params: {}
    });
    const result = await promise;
    assert.equal(result.id, 10);
    assert.ok(result.result.isError);
  });

  it('should handle ping', () => {
    const result = proto.handleMessage({ method: 'ping', id: 11 });
    assert.equal(result.id, 11);
    assert.deepEqual(result.result, {});
  });

  it('should return null for unknown methods', () => {
    const result = proto.handleMessage({ method: 'unknown', id: 12 });
    assert.equal(result, null);
  });

  it('should return null for messages without id', () => {
    const result = proto.handleMessage({ method: 'tools/list' });
    assert.equal(result, null);
  });

  it('should handle tools/call with no arguments', async () => {
    const promise = proto.handleMessage({
      method: 'tools/call', id: 12,
      params: { name: 'greet' }
    });
    const result = await promise;
    assert.equal(result.id, 12);
    assert.equal(result.result.content[0].text, 'Hello, world!');
  });
});
