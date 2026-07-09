import assert from 'node:assert/strict';

export async function testCliModuleCanBeImported() {
  const cli = await import('../src/cli');
  assert.equal(typeof cli.main, 'function');
}

export async function testServerModuleCanBeImported() {
  const server = await import('../src/server');
  assert.equal(typeof server.buildServer, 'function');
}
