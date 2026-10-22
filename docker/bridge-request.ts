import { TextDecoder } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { assertDawnRequest, assertDawnResponse, MAX_WIRE_BYTES, CONTROL_TIMEOUT_MS, SAY_CLIENT_TIMEOUT_MS, type DawnRequest, type DawnResponse } from '../packages/dawn/src/protocol/index.ts';
import { HttpDawnTransport } from '../packages/dawn/src/adapters/transport/http-client.ts';
import { readTokenFile } from '../packages/dawn/src/adapters/transport/token-file.ts';
import { assertPrivateDir, resolveDataDirectory } from './manage.ts';

/** Exactly one bounded JSON line over Docker exec stdin/stdout; EOF before reply cancels. */
export async function serveBridgeRequest(options: {
  input: Readable;
  output: Writable;
  request: (request: DawnRequest, signal: AbortSignal) => Promise<DawnResponse>;
  signal?: AbortSignal;
}): Promise<void> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout>;
  let dispatched = false;
  let chunks: Buffer[] = [];
  let size = 0;
  const started = performance.now();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.input.off('data', onData);
      options.input.off('end', cancel);
      options.input.off('close', cancel);
      // Retain fixed, settled-safe error observers through late stream events;
      // write callbacks can precede the corresponding error event.

      signal.removeEventListener('abort', cancel);
      options.input.pause();
      controller.abort();
      chunks = [];
      if (ok) resolvePromise(); else rejectPromise(new Error('Docker bridge request failed'));
    };
    const cancel = () => finish(false);
    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      if (dispatched) { finish(false); return; }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_WIRE_BYTES + 1) { finish(false); return; }
      chunks.push(bytes);
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      // No second line or trailing bytes: one request, never a command stream.
      if (newline !== bytes.length - 1) { finish(false); return; }
      let request: DawnRequest;
      try {
        const body = Buffer.concat(chunks, size).subarray(0, -1);
        if (body.includes(10) || body.includes(13) || body.length > MAX_WIRE_BYTES) throw new Error();
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body));
        assertDawnRequest(value);
        request = value;
        signal.throwIfAborted();
      } catch { finish(false); return; }
      dispatched = true;
      chunks = [];
      clearTimeout(timer);
      const remaining = (request.type === 'say' ? SAY_CLIENT_TIMEOUT_MS : CONTROL_TIMEOUT_MS) - (performance.now() - started);
      if (remaining <= 0) { finish(false); return; }
      timer = setTimeout(cancel, remaining);
      void (async () => {
        try {
          const response = await options.request(request, signal);
          signal.throwIfAborted();
          assertDawnResponse(response);
          if (response.requestId !== request.requestId || (response.type !== 'error' &&
              (request.type === 'say' ? response.type !== 'reply' :
                ['model-status', 'model-list', 'model-select', 'thinking-select'].includes(request.type) ? response.type !== 'model' : response.type !== 'status'))) throw new Error();
          const body = Buffer.from(JSON.stringify(response), 'utf8');
          if (body.length + 1 > MAX_WIRE_BYTES) throw new Error();
          if (settled) return;
          options.output.write(Buffer.concat([body, Buffer.from('\n')]), error => finish(!error));
        } catch { finish(false); }
      })();
    };
    timer = setTimeout(cancel, CONTROL_TIMEOUT_MS);
    options.input.on('data', onData);
    options.input.once('end', cancel);
    options.input.once('close', cancel);
    options.input.on('error', cancel);
    options.output.on('error', cancel);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel(); else options.input.resume();
  });
}

export async function runContainerBridge(): Promise<void> {
  if (process.argv.length !== 2) throw new Error('Unexpected Docker bridge arguments');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await serveBridgeRequest({ input: process.stdin, output: process.stdout, signal: controller.signal,
      request: (request, signal) => {
        signal.throwIfAborted();
        const dir = assertPrivateDir(resolveDataDirectory());
        const transport = new HttpDawnTransport('http://127.0.0.1:7341', readTokenFile(resolve(dir, 'service.token')));
        return transport.request(request, signal);
      },
    });
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runContainerBridge().catch(() => { process.stderr.write('Docker bridge request failed.\n'); process.exitCode = 1; });
}
