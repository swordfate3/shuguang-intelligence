import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
// JS Host/Client adapters deliberately need no runtime SDK in these contract tests.
import { createHostPlugin } from '../src/host.js';
import { TYPERT, REMOTE_INFO, PACKAGE_NAME } from '../src/remote-contract.js';
import { buildPlugin } from '../build.mjs';
import { DawnBridge } from '../src/bridge.ts';
import { DawnService } from '../../dawn/src/runtime/service.ts';
import { InMemoryStateStore } from '../../dawn/src/adapters/storage/in-memory.ts';
import { createInitialState } from '../../dawn/src/legacy/state.ts';
import { startHttpServer } from '../../dawn/src/adapters/transport/http-server.ts';

test('hand-authored strict Remote codec bounds UTF8, argument type and malformed JSON', () => {
  const descriptor = REMOTE_INFO.descriptors[0]!;
  assert.equal(descriptor.namespace, 'shuguang');
  assert.deepEqual(descriptor.cancellation, { parameter: 'signal' });
  assert.equal(TYPERT.invocations[0], descriptor);
  const input = descriptor.parameters[0]!.codec.create();
  assert.equal(input.parse('status'), 'status');
  assert.equal(input.parse('a'.repeat(16004)).length, 16004);
  for (const bad of [null, {}, '', 'a'.repeat(16005)]) assert.throws(() => input.parse(bad));
  for (const bad of [null, '{}broken', 'null', '[]', JSON.stringify({ text: '中'.repeat(22000) })]) {
    assert.throws(() => descriptor.result.create().parse(bad));
  }
  const value = JSON.stringify({ text: '合成回复' });
  assert.equal(descriptor.result.encode(value), value);
  assert.equal(descriptor.result.decode(value), value);
});

test('Host registers one owner-only service, defers I/O and disposes bridge and descriptors', async () => {
  const cleanups: (() => unknown)[] = [];
  let service: any;
  let contribution: any;
  let commands = 0, closed = 0;
  const context: any = {
    invocation: { peer: { principal: { kind: 'owner' } } },
    effect: (effect: () => () => unknown) => { cleanups.push(effect()); },
    typert: { register: (value: unknown) => { contribution = value; return () => { contribution = undefined; }; } },
  };
  class SDKService {
    ctx: any;
    constructor(ctx: unknown, key: string) { this.ctx = ctx; assert.equal(key, 'shuguang'); service = this; }
  }
  class Bridge {
    constructor(config: unknown) { assert.deepEqual(config, {}); }
    async command(input: string, signal: AbortSignal) { signal.throwIfAborted(); commands++; return { type: 'reply', text: input }; }
    async dispose() { closed++; }
  }
  const plugin = createHostPlugin(SDKService, Bridge);
  assert.deepEqual(plugin.inject, ['typert']);
  plugin.apply(context, {});
  assert.equal(commands, 0);
  assert.equal(contribution, TYPERT);
  assert.deepEqual(JSON.parse(await service.command('say 合成输入', new AbortController().signal)), { type: 'reply', text: 'say 合成输入' });
  assert.equal(commands, 1);
  context.invocation = { peer: { principal: { kind: 'guest' } } };
  await assert.rejects(service.command('status', new AbortController().signal), /owner/);
  context.invocation = undefined;
  await assert.rejects(service.command('status', new AbortController().signal), /owner/);
  assert.equal(commands, 1);
  for (const cleanup of cleanups.reverse()) await cleanup();
  assert.equal(closed, 1); assert.equal(contribution, undefined);
});

test('owner Host adapter reaches real Dawn HTTP/service through default environment credential reader', async () => {
  const variable = 'SHUGUANG_DSH_INTEGRATION_TOKEN';
  const original = process.env[variable];
  const token = 'synthetic_integration_' + 'a'.repeat(43);
  const store = new InMemoryStateStore(createInitialState('synthetic-dsh', '合成主体', '2026-01-01T00:00:00.000Z'));
  const service = new DawnService(store);
  const server = await startHttpServer({ token, port: 0, handler: (request, signal) => service.handle(request, signal) });
  const cleanups: (() => unknown)[] = [];
  let host: any;
  const ctx: any = {
    invocation: { peer: { principal: { kind: 'owner' } } },
    effect: (effect: () => () => unknown) => cleanups.push(effect()),
    typert: { register: () => () => {} },
  };
  class SDKService {
    ctx: any;
    constructor(context: unknown) { this.ctx = context; host = this; }
  }
  try {
    process.env[variable] = token;
    createHostPlugin(SDKService, DawnBridge).apply(ctx, { endpoint: `http://127.0.0.1:${server.port}`, tokenEnv: variable });
    const run = async (command: string) => JSON.parse(await host.command(command, AbortSignal.timeout(5000)));
    assert.equal((await run('status')).revision, 0);
    assert.equal((await run('wake 0')).lifecycle, 'awake');
    assert.equal((await run('wake 0')).code, 'CONFLICT');
    assert.equal((await run('say 仅本次合成输入')).code, 'NOT_IMPLEMENTED');
    for (const cleanup of cleanups.reverse()) await cleanup();
    assert.equal((await store.read(new AbortController().signal)).lifecycle, 'awake');
    assert.equal(store.events().length, 1);
    await assert.rejects(run('status'));
  } finally {
    if (original === undefined) delete process.env[variable]; else process.env[variable] = original;
    await server.close(); await service.close();
  }
});

test('dependency-free build emits self-contained Host and lazy Client with no Node browser imports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dawn-dsh-build-'));
  try {
    const built = await buildPlugin(dir);
    assert.ok(built.modules >= 7);
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(manifest.name, PACKAGE_NAME);
    assert.equal(manifest.exports['.'], './lib/index.js');
    assert.equal(manifest.exports['./client'], './lib/client.js');
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
    assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-typert-protocol'], '0.2.1-rc.2');
    assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/dsh-typert-protocol'].optional, true);
    assert.equal(manifest.exports['./typert'], undefined); // explicit registration, never double load
    assert.equal(manifest.files.includes('lib'), true);
    const en = JSON.parse(await readFile(new URL('../locale/en.json', import.meta.url), 'utf8'));
    const zh = JSON.parse(await readFile(new URL('../locale/zh.json', import.meta.url), 'utf8'));
    assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
    for (const locale of [en, zh]) assert.ok(locale.meta.title && locale.meta.description);
    assert.match(await readFile(new URL('../icon.svg', import.meta.url), 'utf8'), /<svg\b/);
    const license = await readFile(join(dir, 'LICENSE'), 'utf8');
    assert.match(license, /Copyright \(c\) 2026 swordfate3/);
    assert.match(license, /Permission is hereby granted/);
    const entry = await readFile(join(dir, 'index.js'), 'utf8');
    assert.match(entry, /packages\/dsh-plugin\/src\/index\.js/);
    const host = await readFile(join(dir, 'packages/dsh-plugin/src/bridge.js'), 'utf8');
    assert.doesNotMatch(host, /from .*\.ts["']/);
    const code = await readFile(join(dir, 'client.js'), 'utf8');
    assert.doesNotMatch(code, /node:|require\(['"]@deepseek-ai/);
    let registration: any;
    vm.runInNewContext(code, { window: { __ModuleLoader__: { load: (value: unknown) => { registration = value; } } }, TextEncoder, AbortController, AbortSignal });
    assert.equal(registration.id, PACKAGE_NAME);
    const requested: string[] = [];
    const plugin = registration.factory((name: string) => { requested.push(name); return { createElement() {} }; });
    assert.deepEqual(requested, ['react']);
    assert.ok(plugin.inject.includes('remote'));
    const effects: any[] = [], slots: any[] = [], owners: string[] = [];
    let mounts = 0, requests = 0;
    const ctx = {
      effect: (effect: () => unknown) => { effects.push(effect()); },
      locale: { register: () => () => {}, bind: () => () => 'title' },
      remote: { $mount: async (info: any) => { assert.equal(info.package, PACKAGE_NAME); mounts++; },
        get shuguang(): never { throw new Error('namespace access requires inject'); } },
      inject: (names: string[], callback: (child: unknown) => void) => {
        assert.equal(names.join(','), 'remote.shuguang');
        const childEffects: any[] = [];
        callback({ remote: { shuguang: { command: async () => { requests++; return { ok: true, value: JSON.stringify({ type: 'reply', text: '<script>not HTML</script>' }) }; } } },
          effect: (effect: () => unknown) => childEffects.push(effect()) });
        return { dispose: async () => { for (const cleanup of childEffects.reverse()) if (typeof cleanup === 'function') await cleanup(); } };
      },
      slots: { inject: (name: string, effect: () => unknown) => { owners.push(name); effects.push(effect()); },
        register: (options: any, component: unknown) => { slots.push({ options, component }); return () => {}; } },
    };
    plugin.apply(ctx);
    assert.equal(mounts, 1); assert.equal(requests, 0); // no auto status/model probe
    assert.deepEqual(owners, ['main', 'sidebar.panellist']);
    const panel = slots.find(item => item.options.name === 'main');
    assert.equal(panel.options.key, 'shuguang');
    const run = panel.options.inject().run;
    assert.equal((await run('say 合成', new AbortController().signal)).text, '<script>not HTML</script>');
    assert.equal(requests, 1);
    for (const cleanup of effects.reverse()) if (typeof cleanup === 'function') await cleanup();
    await assert.rejects(run('status', new AbortController().signal));
    assert.equal(requests, 1);
  } finally {
    // Owned mkdtemp path only; never delete a source checkout or a data directory.
    assert.ok(dir.startsWith(join(tmpdir(), 'dawn-dsh-build-')));
    await rm(dir, { recursive: true, force: true });
  }
});
