import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { DockerDawnTransport } from '../src/docker-transport.ts';
import { setImmediate } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { serveBridgeRequest } from '../../../docker/bridge-request.ts';
import { DawnBridge, BridgeError } from '../src/bridge.ts';
import { startHttpServer } from '../../dawn/src/adapters/transport/http-server.ts';
import { HttpDawnTransport } from '../../dawn/src/adapters/transport/http-client.ts';
import type { DawnRequest, DawnResponse } from '../../dawn/src/protocol/index.ts';

const request: DawnRequest = { version: 1, requestId: 'synthetic-stdio', type: 'status' };
const failure = (id = request.requestId): DawnResponse => ({ version: 1, requestId: id, type: 'error', code: 'NOT_IMPLEMENTED', message: 'synthetic' });
function fixture(handler: (request: DawnRequest, signal: AbortSignal) => Promise<DawnResponse>) {
  const input = new PassThrough(), output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', chunk => chunks.push(Buffer.from(chunk)));
  const pending = serveBridgeRequest({ input, output, request: handler });
  // Attach the rejection observer before exercising cancellation paths.
  void pending.catch(() => {});
  return { input, output, pending, text: () => Buffer.concat(chunks).toString('utf8') };
}

test('container bridge forwards exactly one strict JSON frame and application errors remain successful transport', async () => {
  let calls = 0;
  const f = fixture(async (value) => { calls++; assert.deepEqual(value, request); return failure(); });
  const line = JSON.stringify(request) + '\n';
  f.input.write(line.slice(0, 10)); f.input.write(line.slice(10));
  await f.pending;
  assert.equal(calls, 1);
  assert.equal(f.text(), JSON.stringify(failure()) + '\n');
  assert.equal(f.input.isPaused(), true);
});

test('malformed, oversized, extra-frame and fatal UTF8 inputs never reach the service', async () => {
  for (const payload of [Buffer.from('{bad}\n'), Buffer.from('{}\n'), Buffer.from(JSON.stringify(request) + '\n{}\n'), Buffer.from('x'.repeat(65538)), Buffer.from([0xff, 10]), Buffer.from(JSON.stringify({ ...request, injected: true }) + '\n'), Buffer.from('\ufeff' + JSON.stringify(request) + '\n'), Buffer.from(JSON.stringify(request) + '\r\n')]) {
    let calls = 0;
    const f = fixture(async () => { calls++; return failure(); });
    f.input.write(payload);
    await assert.rejects(f.pending, /^Error: Docker bridge request failed$/);
    assert.equal(calls, 0); assert.equal(f.text(), '');
  }
});

test('stdin EOF or stream failure aborts HTTP work, rejects late replies and emits no token or result', async () => {
  for (const event of ['end', 'error', 'close']) {
    let signal!: AbortSignal;
    let complete!: (value: DawnResponse) => void;
    const f = fixture(async (_request, incoming) => { signal = incoming; return new Promise(done => { complete = done; }); });
    f.input.write(JSON.stringify(request) + '\n');
    assert.equal(signal.aborted, false);
    if (event === 'end') f.input.end(); else if (event === 'error') f.input.emit('error', new Error('private')); else f.input.destroy();
    await assert.rejects(f.pending);
    assert.equal(signal.aborted, true);
    complete(failure()); await setImmediate();
    assert.equal(f.text(), '');
  }
});

test('incomplete input EOF and external pre-abort never dispatch', async () => {
  const f = fixture(async () => { throw new Error('must not call'); });
  f.input.end('{'); await assert.rejects(f.pending); assert.equal(f.text(), '');
  let calls = 0;
  await assert.rejects(serveBridgeRequest({ input: new PassThrough(), output: new PassThrough(), signal: AbortSignal.abort(), request: async () => { calls++; return failure(); } }));
  assert.equal(calls, 0);
});

test('handler exceptions, mismatched IDs and oversized responses are redacted with no stdout', async () => {
  for (const handler of [async () => { throw new Error('secret-synthetic'); }, async () => failure('wrong-id'), async () => ({ ...failure(), message: 'x'.repeat(65536) })]) {
    const f = fixture(handler);
    f.input.write(JSON.stringify(request) + '\n');
    await assert.rejects(f.pending, /^Error: Docker bridge request failed$/);
    assert.equal(f.text(), '');
  }
});

test('stdio handler uses real authenticated loopback HTTP without changing Host or Origin protection', async () => {
  const token = 'synthetic_' + 's'.repeat(43);
  let calls = 0;
  const server = await startHttpServer({ port: 0, token, handler: async value => { calls++; return failure(value.requestId); } });
  try {
    const transport = new HttpDawnTransport(`http://127.0.0.1:${server.port}`, token);
    const f = fixture((value, signal) => transport.request(value, signal));
    f.input.write(JSON.stringify(request) + '\n'); await f.pending;
    assert.equal(calls, 1); assert.deepEqual(JSON.parse(f.text()), failure());
    const wrong = fixture((value, signal) => new HttpDawnTransport(`http://127.0.0.1:${server.port}`, 'wrong_' + 'x'.repeat(43)).request(value, signal));
    wrong.input.write(JSON.stringify(request) + '\n'); await assert.rejects(wrong.pending);
    assert.equal(calls, 1); assert.equal(wrong.text(), '');
  } finally { await server.close(); }
});

test('Docker bridge mode never reads Host token/env and invalid or HTTP-mixed config never dispatches', async () => {
  let reads = 0, spawned = 0;
  const bridge = new DawnBridge({ connection: 'docker', dockerProjectDir: process.cwd(), dockerContext: 'desktop-linux', dockerProjectName: 'synthetic-dawn' }, {
    readToken: () => { reads++; throw Error(); }, readEnv: () => { reads++; throw Error(); },
    dockerTransport: config => { assert.equal(config.dockerProjectName, 'synthetic-dawn'); return { request: async value => { spawned++; return failure(value.requestId); } }; },
  });
  assert.equal(reads, 0); assert.equal(spawned, 0);
  assert.equal((await bridge.command('status', new AbortController().signal)).type, 'error');
  assert.equal(reads, 0); assert.equal(spawned, 1);
  await bridge.dispose();
  for (const config of [{ connection: 'shell' }, { connection: 'docker' }, { connection: 'docker', dockerProjectDir: process.cwd(), endpoint: 'http://127.0.0.1:7341' }, { connection: 'http', dockerProjectDir: process.cwd() }]) {
    const bad = new DawnBridge(config, { dockerTransport: () => { throw Error('must not instantiate'); } });
    await assert.rejects(bad.command('status', new AbortController().signal), error => error instanceof BridgeError);
    await bad.dispose();
  }
});

test('Host Docker transport and container stdio handler integrate with real loopback HTTP, without docker daemon', async () => {
  const token = 'synthetic_' + 't'.repeat(43);
  const server = await startHttpServer({ port: 0, token, handler: async value => failure(value.requestId) });
  try {
    let calls = 0;
    const transport = new DockerDawnTransport({ dockerProjectDir: process.cwd() }, { spawnRunner: () => {
      calls++;
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
      const http = new HttpDawnTransport(`http://127.0.0.1:${server.port}`, token);
      void serveBridgeRequest({ input: child.stdin, output: child.stdout, request: (value, signal) => http.request(value, signal) }).then(() => {
        child.stdout.end(() => { child.emit('exit', 0, null); child.emit('close', 0, null); });
      }, () => { child.emit('close', 1, null); });
      return child;
    } });
    assert.deepEqual(await transport.request(request, new AbortController().signal), failure());
    assert.equal(calls, 1);
  } finally { await server.close(); }
});

test('response wire bound includes LF and late output error stays observed', async () => {
  const modelRequest: DawnRequest = { version: 1, requestId: 'synthetic-wire', type: 'say', text: 'synthetic' };
  const base: DawnResponse = { version: 1, requestId: modelRequest.requestId, type: 'error', code: 'NOT_IMPLEMENTED', message: 'synthetic' };
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('synthetic-private-output-error')); } });
  const input = new PassThrough();
  const pending = serveBridgeRequest({ input, output, request: async () => base });
  input.write(JSON.stringify(modelRequest) + '\n');
  await assert.rejects(pending, /^Error: Docker bridge request failed$/);
  await setImmediate(); // callback followed by error event must not be unhandled
  const frame = (bytes: number): DawnResponse => {
    const empty = { version: 1 as const, requestId: modelRequest.requestId, type: 'reply' as const, text: '' };
    const needed = bytes - Buffer.byteLength(JSON.stringify(empty));
    // Escaped NUL consumes 6 wire bytes while remaining within 16000 chars.
    return { ...empty, text: '\u0000'.repeat(Math.floor(needed / 6)) + 'a'.repeat(needed % 6) };
  };
  for (const bytes of [65535, 65536]) {
    const f = fixture(async () => frame(bytes));
    f.input.write(JSON.stringify(modelRequest) + '\n');
    if (bytes === 65535) { await f.pending; assert.equal(Buffer.byteLength(f.text()), 65536); }
    else { await assert.rejects(f.pending); assert.equal(f.text(), ''); }
  }
});

test('container packaging explicitly includes stdio entry without publishing ports or model env injection', () => {
  const entry = readFileSync(new URL('../../../docker/entrypoint.sh', import.meta.url), 'utf8');
  const block = entry.slice(entry.indexOf('  bridge-request)'), entry.indexOf('  status)'));
  assert.match(block, /\[ "\$#" -eq 0 \]/);
  assert.match(block, /exec node "\$APP\/docker\/bridge-request.ts"/);
  assert.doesNotMatch(block, /env-file|model\.env|service\.token|--host/);
  assert.match(readFileSync(new URL('../../../.dockerignore', import.meta.url), 'utf8'), /^!docker\/bridge-request\.ts$/m);
  assert.doesNotMatch(readFileSync(new URL('../../../compose.yaml', import.meta.url), 'utf8'), /^\s*(ports|network_mode|privileged):/m);
});
