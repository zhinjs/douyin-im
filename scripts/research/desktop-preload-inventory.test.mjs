import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inventoryPreload } from './desktop-preload-inventory.mjs';

test('indexes IPC calls and duplicate channels without treating them as business capabilities', () => {
  const result = inventoryPreload(`(() => {
    const channel = 'shared';
    const api = {
      read: () => e.ipcRenderer.invoke(channel),
      watch: cb => e.ipcRenderer.on(channel, cb),
      write: () => e.ipcRenderer.send('literal'),
      ignore: () => arbitrary.invoke(channel),
    };
  })();`);
  assert.equal(result.callCount, 3); assert.equal(result.channelCount, 2);
  assert.deepEqual(result.calls.map(({method, kind, channel}) => ({method, kind, channel})), [
    {method: 'read', kind: 'invoke', channel: 'shared'},
    {method: 'watch', kind: 'on', channel: 'shared'},
    {method: 'write', kind: 'send', channel: 'literal'},
  ]);
  assert.deepEqual(result.unresolved, []);
});

test('reports unresolved dynamic channels rather than inventing a name', () => {
  const result = inventoryPreload(`(() => { const api = { dynamic: name => e.ipcRenderer.invoke(name) }; })();`);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].channel, null);
});

test('does not execute source or collect aliases from other callback scopes', () => {
  const result = inventoryPreload(`(() => {
    throw new Error('must never run');
    const channel = 'outer';
    const api = { read: () => e.ipcRenderer.invoke(channel), other: () => { const channel = 'inner'; return channel; } };
  })();`);
  assert.equal(result.calls[0].channel, 'outer');
});

test('rejects invalid source instead of returning a misleading empty inventory', () => {
  assert.throws(() => inventoryPreload('(() => {'), /syntax errors/);
});

test('keeps once listeners, including caller-selected channels, in the inventory', () => {
  const result = inventoryPreload(`(() => { const channel = 'finished'; const api = {
    finished: cb => e.ipcRenderer.once(channel, cb),
    selected: (name, cb) => e.ipcRenderer.once(name, cb),
  }; })();`);
  assert.equal(result.callCount, 2);
  assert.equal(result.channelCount, 1);
  assert.equal(result.calls[0].channel, 'finished');
  assert.equal(result.unresolved[0].method, 'selected');
  assert.equal(result.unresolved[0].channelExpression, 'name');
});

test('does not misresolve shadowed parameters, local constants or mutable aliases', () => {
  const result = inventoryPreload(`(() => { const channel = 'outer'; let mutable = 'initial'; const api = {
    parameter: channel => e.ipcRenderer.invoke(channel),
    local: () => { const channel = 'inner'; return e.ipcRenderer.invoke(channel); },
    mutable: () => e.ipcRenderer.invoke(mutable),
    unshadowed: () => e.ipcRenderer.invoke(channel),
  }; })();`);
  assert.deepEqual(result.calls.map(call => call.channel), [null, null, null, 'outer']);
  assert.equal(result.unresolved.length, 3);
});

test('does not silently discard IPC methods outside the original three-method filter', () => {
  const result = inventoryPreload(`(() => { const api = { extra: () => e.ipcRenderer.sendSync('sync') }; })();`);
  assert.equal(result.callCount, 1);
  assert.equal(result.calls[0].kind, 'sendSync');
});
