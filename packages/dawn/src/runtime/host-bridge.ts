import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { HostHttpClient } from "../adapters/transport/host-http-client.ts";
import { assertHostRequest, HOST_MAX_BYTES, type HostRequest } from "../protocol/host.ts";

/** Private JSONL, not MCP. Input pumping stays independent of request/output waits so EOF fences promptly. */
export async function serveHostBridge(input: Readable, output: Writable, client: HostHttpClient, rootSignal: AbortSignal): Promise<void> {
  const local = new AbortController();
  const signal = AbortSignal.any([rootSignal, local.signal]);
  let pending = Buffer.alloc(0);
  const queue: { request: HostRequest; bytes: number }[] = [];
  let queuedBytes = 0;
  let wake: (() => void) | undefined;
  let ended = false;
  let failed = false;
  let executing = false;
  const stop = (): void => {
    local.abort(); client.close();
    input.destroy();
    wake?.(); wake = undefined;
  };
  const fail = (): void => { failed = true; stop(); };
  const eof = (): void => { ended = true; stop(); };
  const data = (chunk: Buffer | string): void => {
    if (signal.aborted) return;
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (pending.length + bytes.length + queuedBytes > HOST_MAX_BYTES * 2) throw new Error("Private host input too large");
      pending = Buffer.concat([pending, bytes]);
      for (;;) {
        const newline = pending.indexOf(10);
        if (newline < 0) break;
        if (newline > HOST_MAX_BYTES) throw new Error("Private host frame too large");
        const frame = pending.subarray(0, newline); pending = pending.subarray(newline + 1);
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
        assertHostRequest(value);
        if (value.type === "pair" || queue.length >= 8) throw new Error("Private host queue denied");
        queue.push({ request: value, bytes: frame.length }); queuedBytes += frame.length;
      }
      if (pending.length > HOST_MAX_BYTES) throw new Error("Private host frame too large");
      wake?.(); wake = undefined;
    } catch { fail(); }
  };
  const sink = (): void => {};
  input.on("error", sink); output.on("error", sink);
  input.on("data", data); input.once("end", eof); input.once("close", eof); input.once("error", fail);
  output.once("error", fail); output.once("close", fail);
  rootSignal.addEventListener("abort", fail, { once: true });
  if (rootSignal.aborted) fail();
  try {
    const pair = await client.request({ version: 1, requestId: randomUUID(), type: "pair" }, signal);
    if (pair.type !== "paired") throw new Error("Host pairing failed");
    for (;;) {
      if (signal.aborted) {
        if (failed || executing) throw new Error("Private host operation interrupted");
        break;
      }
      const next = queue.shift();
      if (!next) {
        await new Promise<void>(resolve => { wake = resolve; if (signal.aborted) resolve(); });
        continue;
      }
      queuedBytes -= next.bytes;
      executing = true;
      const response = await client.request(next.request, signal);
      signal.throwIfAborted();
      const line = JSON.stringify(response) + "\n";
      if (!output.write(line)) await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          clearTimeout(timer); output.off("drain", drain); output.off("close", closed); output.off("error", closed); signal.removeEventListener("abort", closed);
        };
        const drain = (): void => { cleanup(); resolve(); };
        const closed = (): void => { cleanup(); reject(new Error("Private host output closed")); };
        const timer = setTimeout(closed, 10_000);
        output.once("drain", drain); output.once("close", closed); output.once("error", closed); signal.addEventListener("abort", closed, { once: true });
        if (signal.aborted || output.destroyed) closed();
      });
      executing = false;
    }
  } catch {
    if (failed || !ended || executing) throw new Error("Private host bridge failed");
  } finally {
    stop();
    rootSignal.removeEventListener("abort", fail);
    input.off("data", data); input.off("end", eof); input.off("close", eof); input.off("error", fail);
    output.off("error", fail); output.off("close", fail);
    // Retain redacting sinks through destroy(error)/close races; release on actual close.
    for (const stream of [input, output]) {
      if (stream.closed) stream.off("error", sink);
      else stream.once("close", () => stream.off("error", sink));
    }
  }
}
