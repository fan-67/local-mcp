import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { WORKSPACE } from '../lib/config.mjs';

// Import functions from local-mcp.mjs
import {
  nl, compactDiff, applyEdit, fileUriToPath, pathToFileUri,
  treeDir, findBlock, listResources, readResource
} from '../local-mcp.mjs';

describe('nl()', () => {
  it('should convert CRLF to LF', () => {
    assert.equal(nl('hello\r\nworld'), 'hello\nworld');
  });
  it('should handle null/undefined', () => {
    assert.equal(nl(null), '');
    assert.equal(nl(undefined), '');
    assert.equal(nl(''), '');
  });
  it('should leave LF as-is', () => {
    assert.equal(nl('hello\nworld'), 'hello\nworld');
  });
  it('should handle mixed line endings', () => {
    assert.equal(nl('a\r\nb\nc\r\nd'), 'a\nb\nc\nd');
  });
});

describe('compactDiff()', () => {
  it('should count additions and deletions', () => {
    const diff = [
      '--- old.txt',
      '+++ new.txt',
      '@@ -1,3 +1,4 @@',
      ' line1',
      '+added line',
      '-removed line',
      ' unchanged',
      ''
    ].join('\n');
    assert.equal(compactDiff(diff), '+1/-1 lines');
  });
  it('should return +0/-0 for empty diff', () => {
    assert.equal(compactDiff(''), '+0/-0 lines');
  });
  it('should not count diff headers', () => {
    const diff = [
      '--- a/file',
      '+++ b/file',
      '@@ -0,0 +1 @@',
      '+new file',
      ''
    ].join('\n');
    assert.equal(compactDiff(diff), '+1/-0 lines');
  });
  it('should handle multiple hunks', () => {
    const diff = [
      '--- a/file', '+++ b/file',
      '@@ -1 +1,2 @@',
      ' base',
      '+add1',
      '@@ -10 +11,2 @@',
      '-del1',
      '+add2',
      ''
    ].join('\n');
    assert.equal(compactDiff(diff), '+2/-1 lines');
  });
});

describe('applyEdit()', () => {
  it('should replace exact match', () => {
    const result = applyEdit('hello world', 'world', 'there');
    assert.equal(result, 'hello there');
  });
  it('should handle multi-line exact match', () => {
    const content = 'line1\nline2\nline3';
    const result = applyEdit(content, 'line2', 'changed');
    assert.equal(result, 'line1\nchanged\nline3');
  });
  it('should use fuzzy match when indentation differs', () => {
    const content = '  hello\n  world\n  foo';
    const result = applyEdit(content, 'world', 'there');
    assert.equal(result, '  hello\n  there\n  foo');
  });
  it('should preserve indentation in fuzzy match', () => {
    const content = 'function a() {\n    console.log("hi");\n}';
    const result = applyEdit(content, 'console.log("hi");', 'console.log("hello");');
    assert.equal(result, 'function a() {\n    console.log("hello");\n}');
  });
  it('should throw MATCH_NOT_FOUND when no match', () => {
    assert.throws(
      () => applyEdit('hello world', 'nonexistent', 'x'),
      e => e.type === 'MATCH_NOT_FOUND'
    );
  });
  it('should replace newText with empty string', () => {
    const result = applyEdit('hello world foo', 'world', '');
    assert.equal(result, 'hello  foo');
  });
});

describe('fileUriToPath()', () => {
  it('should convert file:// URI to path', () => {
    const result = fileUriToPath('file:///home/user/test.txt');
    // On non-Windows: /home/user/test.txt
    if (process.platform !== 'win32') {
      assert.equal(result, '/home/user/test.txt');
    }
  });
  it('should handle encoded characters', () => {
    const result = fileUriToPath('file:///home/user/file%20name.txt');
    if (process.platform !== 'win32') {
      assert.equal(result, '/home/user/file name.txt');
    }
  });
  it('should throw INVALID_URI for non-file URIs', () => {
    assert.throws(
      () => fileUriToPath('http://example.com'),
      e => e.type === 'INVALID_URI'
    );
  });
  it('should throw INVALID_URI for empty string', () => {
    assert.throws(
      () => fileUriToPath(''),
      e => e.type === 'INVALID_URI'
    );
  });
});

describe('pathToFileUri()', () => {
  it('should convert absolute path to file:// URI', () => {
    const result = pathToFileUri('/home/user/test.txt');
    if (process.platform !== 'win32') {
      assert.equal(result, 'file:///home/user/test.txt');
    }
  });
  it('should resolve relative paths', () => {
    const result = pathToFileUri('.');
    assert.ok(result.startsWith('file://'));
  });
});

describe('findBlock()', () => {
  it('should find function by name', () => {
    const lines = [
      'function foo() {',
      '  return 42;',
      '}'
    ];
    const block = findBlock(lines, 'foo');
    assert.ok(block);
    assert.equal(block.start, 0);
    assert.equal(block.end, 2);
  });
  it('should find const arrow function', () => {
    const lines = [
      'const foo = () => {',
      '  return 42;',
      '}'
    ];
    const block = findBlock(lines, 'foo');
    assert.ok(block);
    assert.equal(block.start, 0);
    assert.equal(block.end, 2);
  });
  it('should return null for missing function', () => {
    const lines = ['const x = 1;'];
    const block = findBlock(lines, 'nonexistent');
    assert.equal(block, null);
  });
  it('should handle nested braces', () => {
    const lines = [
      'function outer() {',
      '  if (true) {',
      '    inner();',
      '  }',
      '}'
    ];
    const block = findBlock(lines, 'outer');
    assert.ok(block);
    assert.equal(block.start, 0);
    assert.equal(block.end, 4);
  });
});

describe('treeDir()', () => {
  let tmpDir;
  before(() => {
    tmpDir = mkdtempSync(join(WORKSPACE, '.tree-test-'));
    mkdirSync(join(tmpDir, 'subdir'), { recursive: true });
    writeFileSync(join(tmpDir, 'a.txt'), 'a');
    writeFileSync(join(tmpDir, 'b.txt'), 'b');
    writeFileSync(join(tmpDir, 'subdir', 'c.txt'), 'c');
  });
  after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('should list files with tree structure', () => {
    const result = treeDir(tmpDir, 2);
    assert.ok(result.includes('a.txt'));
    assert.ok(result.includes('b.txt'));
    assert.ok(result.includes('subdir'));
    assert.ok(result.includes('└──') || result.includes('├──'));
  });

  it('should limit depth', () => {
    const result = treeDir(tmpDir, 1);
    assert.ok(result.includes('subdir'));
    if (readdirSync(tmpDir).length > 0) {
      assert.ok(result.includes('...') || result.includes('c.txt'));
    }
  });
});

describe('listResources()', () => {
  it('should return workspace resource', () => {
    const resources = listResources();
    assert.ok(Array.isArray(resources));
    assert.ok(resources.length >= 1);
    assert.ok(resources[0].uri.startsWith('file://'));
    assert.equal(resources[0].name, 'Workspace root');
    assert.equal(resources[0].mimeType, 'inode/directory');
  });
});

describe('readResource()', () => {
  let tmpFile, tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(WORKSPACE, '.res-test-'));
    tmpFile = join(tmpDir, 'test.json');
    writeFileSync(tmpFile, JSON.stringify({ key: 'value' }));
  });
  after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('should read a file and detect JSON mime type', () => {
    const result = readResource('file://' + tmpFile);
    assert.equal(result.mimeType, 'application/json');
    assert.ok(result.text.includes('"key"'));
  });

  it('should read a directory', () => {
    const result = readResource('file://' + tmpDir);
    assert.equal(result.mimeType, 'inode/directory');
    assert.ok(typeof result.text === 'string');
  });
});
