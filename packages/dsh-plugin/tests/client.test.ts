import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createClientPlugin } from '../src/client.js';

type Tree = { type: unknown; props: Record<string, any>; children: unknown[] };
type Hook = { value?: any; dependencies?: readonly unknown[]; cleanup?: () => void };

/** A deliberately small sequential hooks runner, not a DOM or a React substitute. */
function hooksRuntime() {
  const hooks: Hook[] = [];
  let cursor = 0;
  let mounted = true;
  let writesAfterUnmount = 0;
  let effects: (() => void)[] = [];
  const React = {
    createElement(type: unknown, props: Record<string, any> | null, ...children: unknown[]): Tree {
      return { type, props: props ?? {}, children };
    },
    useState(initial: unknown) {
      const index = cursor++;
      const slot = hooks[index] ?? (hooks[index] = { value: initial });
      return [slot.value, (value: unknown) => {
        if (!mounted) writesAfterUnmount++;
        slot.value = typeof value === 'function' ? value(slot.value) : value;
      }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      const slot = hooks[index] ?? (hooks[index] = { value: { current: initial } });
      return slot.value;
    },
    useEffect(effect: () => (() => void) | void, dependencies: readonly unknown[]) {
      const index = cursor++;
      const previous = hooks[index];
      if (!previous || dependencies.some((value, offset) => !Object.is(value, previous.dependencies?.[offset]))) {
        const slot = hooks[index] ?? (hooks[index] = {});
        slot.dependencies = dependencies;
        effects.push(() => {
          slot.cleanup?.();
          const cleanup = effect();
          if (typeof cleanup === 'function') slot.cleanup = cleanup;
        });
      }
    },
  };
  return {
    React,
    render(component: (props: any) => Tree, props: any) {
      assert.equal(mounted, true);
      cursor = 0;
      const tree = component(props);
      const current = effects;
      effects = [];
      for (const effect of current) effect();
      return tree;
    },
    unmount() {
      mounted = false;
      for (const hook of hooks) hook.cleanup?.();
    },
    get writesAfterUnmount() { return writesAfterUnmount; },
  };
}

function nodes(value: unknown): Tree[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('children' in value)) return [];
  const tree = value as Tree;
  return [tree, ...tree.children.flatMap(nodes)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object' && 'children' in value) return text((value as Tree).children);
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
function only(tree: Tree, predicate: (node: Tree) => boolean): Tree {
  const matches = nodes(tree).filter(predicate);
  assert.equal(matches.length, 1, 'expected one matching rendered element');
  return matches[0]!;
}
function button(tree: Tree, label: string): Tree {
  return only(tree, node => node.type === 'button' && text(node) === label);
}
const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const status = (revision: number, lifecycle = 'sleeping') => ({
  version: 1, requestId: 'synthetic-request', type: 'status', lifecycle, revision,
  runtime: { instanceId: 'synthetic-instance', startedAt: '2026-01-01T00:00:00.000Z', autonomy: false },
});
const model = (selectionRevision: number, selected = 'synthetic-model', thinking = 'off') => ({
  version: 1, requestId: 'synthetic-request', type: 'model', state: {
    selectionRevision, model: selected, thinking, models: ['synthetic-model', 'other-model'],
    levels: ['off', 'low'], calls: 0, maxCalls: 4,
  },
});
interface RemoteCall { input: string; signal: AbortSignal }
function harness(handler: (input: string, signal: AbortSignal) => unknown | Promise<unknown> = () => status(0)) {
  const runtime = hooksRuntime();
  const registrations: { options: any; component: any }[] = [];
  const cleanups: (() => unknown)[] = [];
  const calls: RemoteCall[] = [];
  let dependency: ((child: any) => unknown) | undefined;
  let childCleanups: (() => unknown)[] = [];
  let injectionDisposed = false;
  let dependentDisposals = 0;
  let remoteUnmounts = 0;
  let originalNamespaceReads = 0;
  const revokeNamespace = async () => {
    const current = childCleanups;
    childCleanups = [];
    for (const cleanup of current.toReversed()) await cleanup();
  };
  const restoreNamespace = () => {
    assert.ok(dependency, 'dependent namespace injection must already be registered');
    assert.equal(injectionDisposed, false);
    assert.equal(childCleanups.length, 0, 'previous dependent effects must be revoked first');
    const child = {
      remote: { shuguang: {
        async command(input: string, signal: AbortSignal) {
          calls.push({ input, signal });
          const value = await handler(input, signal);
          return { ok: true, value: JSON.stringify(value) };
        },
      } },
      effect(effect: () => unknown) {
        const cleanup = effect();
        if (typeof cleanup === 'function') childCleanups.push(cleanup as () => unknown);
      },
    };
    dependency(child);
  };
  const ctx = {
    // Deliberate unrelated host history: the Client has no reason to read or send it.
    history: ['PRIVATE_DSH_HOST_HISTORY'],
    effect(effect: () => unknown) {
      const cleanup = effect();
      if (typeof cleanup === 'function') cleanups.push(cleanup as () => unknown);
    },
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    remote: {
      $mount: async () => () => { remoteUnmounts++; },
      get shuguang(): never {
        originalNamespaceReads++;
        throw new Error('remote.shuguang requires a dependent injection child');
      },
    },
    inject(dependencies: string[], callback: (child: any) => unknown) {
      assert.deepEqual(dependencies, ['remote.shuguang']);
      assert.equal(dependency, undefined, 'only one namespace follower is needed');
      dependency = callback;
      restoreNamespace();
      return {
        async dispose() {
          injectionDisposed = true;
          dependentDisposals++;
          await revokeNamespace();
        },
      };
    },
    slots: {
      inject(_name: string, effect: () => unknown) { effect(); },
      register(options: any, component: any) { registrations.push({ options, component }); return () => {}; },
    },
  };
  createClientPlugin(runtime.React, {}).apply(ctx);
  const panel = registrations.find(value => value.options.name === 'main');
  assert.ok(panel);
  const props = { t: (key: string) => key, ...panel.options.inject() };
  let tree = runtime.render(panel.component, props);
  const render = () => (tree = runtime.render(panel.component, props));
  return {
    calls,
    runtime,
    get tree() { return tree; },
    render,
    revokeNamespace,
    restoreNamespace,
    get originalNamespaceReads() { return originalNamespaceReads; },
    get dependentDisposals() { return dependentDisposals; },
    get remoteUnmounts() { return remoteUnmounts; },
    async flush() { await setImmediate(); render(); },
    async disposePlugin() { for (const cleanup of cleanups.toReversed()) await cleanup(); },
  };
}

test('Panel mounting/rendering makes no request; explicit status supplies revision for exact wake/sleep CAS', async () => {
  const ui = harness(input => input === 'status' ? status(4) : input === 'wake 4' ? status(5, 'awake') : status(6));
  assert.equal(ui.calls.length, 0);
  assert.equal(button(ui.tree, 'wake').props.disabled, true);
  assert.equal(button(ui.tree, 'sleep').props.disabled, true);
  ui.render();
  assert.equal(ui.calls.length, 0);
  button(ui.tree, 'status').props.onClick();
  await ui.flush();
  assert.equal(only(ui.tree, node => node.type === 'input').props.value, '4');
  assert.match(text(only(ui.tree, node => node.type === 'pre')), /sleeping · revision=4 · instance=synthetic-instance/);
  button(ui.tree, 'wake').props.onClick();
  await ui.flush();
  button(ui.tree, 'sleep').props.onClick();
  await ui.flush();
  assert.deepEqual(ui.calls.map(value => value.input), ['status', 'wake 4', 'sleep 5']);
  ui.runtime.unmount();
  await ui.disposePlugin();
});

test('lifecycle revision rejects noncanonical, unsafe and empty input without any request', async () => {
  const ui = harness();
  for (const value of ['', '-1', '01', '1.5', '9007199254740992', ' 1', '1 ']) {
    only(ui.tree, node => node.type === 'input').props.onChange({ target: { value } });
    ui.render();
    button(ui.tree, 'wake').props.onClick();
    button(ui.tree, 'sleep').props.onClick();
  }
  await ui.flush();
  assert.equal(ui.calls.length, 0);
  ui.runtime.unmount();
  await ui.disposePlugin();
});

test('say submits only this trimmed message, never host history, and clears the stale subject revision', async () => {
  const ui = harness(input => input === 'status' ? status(7) : { type: 'reply', text: '<script>plain synthetic reply</script>' });
  button(ui.tree, 'status').props.onClick();
  await ui.flush();
  only(ui.tree, node => node.type === 'textarea').props.onChange({ target: { value: '  only this synthetic message  ' } });
  ui.render();
  let prevented = 0;
  only(ui.tree, node => node.type === 'form').props.onSubmit({ preventDefault() { prevented++; } });
  await ui.flush();
  assert.equal(prevented, 1);
  assert.deepEqual(ui.calls.map(value => value.input), ['status', 'say only this synthetic message']);
  assert.equal(JSON.stringify(ui.calls.map(value => value.input)).includes('PRIVATE_DSH_HOST_HISTORY'), false);
  const output = only(ui.tree, node => node.type === 'pre');
  assert.equal(text(output), '<script>plain synthetic reply</script>');
  assert.equal(Object.hasOwn(output.props, 'dangerouslySetInnerHTML'), false);
  assert.equal(only(ui.tree, node => node.type === 'input').props.value, '');
  assert.equal(button(ui.tree, 'wake').props.disabled, true);
  assert.equal(button(ui.tree, 'sleep').props.disabled, true);
  only(ui.tree, node => node.type === 'textarea').props.onChange({ target: { value: '   ' } });
  ui.render();
  only(ui.tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await ui.flush();
  assert.equal(ui.calls.length, 2);
  ui.runtime.unmount();
  await ui.disposePlugin();
});

test('application errors and rejected remote exceptions render fixed failures, never raw remote details', async () => {
  const raw = 'PRIVATE_REMOTE_ERROR_PATH_TOKEN';
  let invocation = 0;
  const ui = harness(() => {
    if (++invocation === 1) return { type: 'error', code: 'CONFLICT', message: raw };
    throw new Error(raw);
  });
  button(ui.tree, 'status').props.onClick();
  await ui.flush();
  assert.equal(text(only(ui.tree, node => node.props.role === 'alert')), 'failure (CONFLICT)');
  assert.equal(text(ui.tree).includes(raw), false);
  button(ui.tree, 'status').props.onClick();
  await ui.flush();
  assert.equal(text(only(ui.tree, node => node.props.role === 'alert')), 'failure');
  assert.equal(text(ui.tree).includes(raw), false);
  ui.runtime.unmount();
  await ui.disposePlugin();
});

test('pending disables every mutable control except cancel and stale double-click handlers cannot duplicate requests', async () => {
  const waiting = deferred<unknown>();
  const ui = harness(() => waiting.promise);
  const click = button(ui.tree, 'status').props.onClick;
  click(); click();
  ui.render();
  await setImmediate();
  assert.equal(ui.calls.length, 1);
  for (const node of nodes(ui.tree).filter(node => ['button', 'input', 'select', 'textarea'].includes(String(node.type)))) {
    assert.equal(node.props.disabled, node.type !== 'button' || text(node) !== 'cancel');
  }
  assert.equal(only(ui.tree, node => node.props.role === 'status').props['aria-busy'], true);
  assert.equal(text(only(ui.tree, node => node.props.role === 'status')), 'pending');
  waiting.resolve(status(2));
  await ui.flush();
  assert.equal(button(ui.tree, 'status').props.disabled, false);
  assert.equal(button(ui.tree, 'cancel').props.disabled, true);
  assert.equal(ui.calls.length, 1);
  ui.runtime.unmount();
  await ui.disposePlugin();
});

test('cancel aborts the exact remote signal, rejects late success and sends neither sleep nor shutdown', async () => {
  const waiting = deferred<unknown>();
  const ui = harness(() => waiting.promise);
  button(ui.tree, 'status').props.onClick();
  await ui.flush();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0]!.signal.aborted, false);
  button(ui.tree, 'cancel').props.onClick();
  assert.equal(ui.calls[0]!.signal.aborted, true);
  waiting.resolve(status(999));
  await ui.flush();
  assert.equal(only(ui.tree, node => node.type === 'input').props.value, '');
  assert.equal(text(only(ui.tree, node => node.type === 'pre')), '');
  assert.equal(text(ui.tree).includes('revision=999'), false);
  assert.equal(text(only(ui.tree, node => node.props.role === 'alert')), 'failure');
  assert.deepEqual(ui.calls.map(value => value.input), ['status']);
  ui.runtime.unmount();
  await ui.disposePlugin();
});

test('Panel unmount aborts pending and suppresses all late state writes without a lifecycle command', async () => {
  const waiting = deferred<unknown>();
  const ui = harness(() => waiting.promise);
  button(ui.tree, 'status').props.onClick();
  await ui.flush();
  ui.runtime.unmount();
  assert.equal(ui.calls[0]!.signal.aborted, true);
  waiting.resolve(status(999));
  await setImmediate();
  assert.equal(ui.runtime.writesAfterUnmount, 0);
  assert.deepEqual(ui.calls.map(value => value.input), ['status']);
  await ui.disposePlugin();
});

test('namespace revocation aborts pending, rejects late results and blocks calls until explicit action after restoration', async () => {
  const waiting = deferred<unknown>();
  const ui = harness(() => ui.calls.length === 1 ? waiting.promise : status(8));
  button(ui.tree, 'status').props.onClick();
  await ui.flush();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.originalNamespaceReads, 0, 'original context must never access an uninjected namespace');
  assert.equal(ui.calls[0]!.signal.aborted, false);
  await ui.revokeNamespace();
  assert.equal(ui.calls[0]!.signal.aborted, true, 'dependent effect cleanup must cancel in-flight namespace requests');
  waiting.resolve(status(999));
  await ui.flush();
  assert.equal(only(ui.tree, node => node.type === 'input').props.value, '');
  assert.equal(text(ui.tree).includes('revision=999'), false);
  button(ui.tree, 'status').props.onClick();
  await ui.flush();
  assert.equal(ui.calls.length, 1, 'unavailable namespace must not dispatch or retry');
  assert.equal(text(only(ui.tree, node => node.props.role === 'alert')), 'failure');
  ui.restoreNamespace();
  await ui.flush();
  assert.equal(ui.calls.length, 1, 'dependency recovery must not retry or auto-probe');
  button(ui.tree, 'status').props.onClick();
  await ui.flush();
  assert.equal(ui.calls.length, 2);
  assert.equal(only(ui.tree, node => node.type === 'input').props.value, '8');
  assert.equal(ui.calls[1]!.signal.aborted, false);
  assert.equal(ui.originalNamespaceReads, 0);
  ui.runtime.unmount();
  await ui.disposePlugin();
});

test('plugin disposal cleans up dependent injection and remote mount, aborts work and never redispatches', async () => {
  const waiting = deferred<unknown>();
  const ui = harness(() => waiting.promise);
  button(ui.tree, 'status').props.onClick();
  await ui.flush();
  assert.equal(ui.calls.length, 1);
  await ui.disposePlugin();
  assert.equal(ui.dependentDisposals, 1);
  assert.equal(ui.remoteUnmounts, 1);
  assert.equal(ui.calls[0]!.signal.aborted, true);
  waiting.resolve(status(999));
  await ui.flush();
  assert.equal(only(ui.tree, node => node.type === 'input').props.value, '');
  button(ui.tree, 'status').props.onClick();
  await ui.flush();
  assert.deepEqual(ui.calls.map(value => value.input), ['status']);
  assert.equal(ui.originalNamespaceReads, 0);
  ui.runtime.unmount();
});

test('model selection uses selection CAS independently from lifecycle, and directory refresh is explicit', async () => {
  const ui = harness(input => {
    if (input === 'model-status') return model(11);
    if (input === 'model 11 other-model') return model(12, 'other-model');
    if (input === 'thinking 12 low') return model(13, 'other-model', 'low');
    if (input === 'models') return model(13, 'other-model', 'low');
    throw new Error('unexpected synthetic request');
  });
  assert.equal(nodes(ui.tree).some(node => node.type === 'select'), false);
  button(ui.tree, 'modelStatus').props.onClick();
  await ui.flush();
  assert.deepEqual(ui.calls.map(value => value.input), ['model-status']);
  const modelSelect = only(ui.tree, node => node.type === 'select' && node.props.value === 'synthetic-model');
  assert.deepEqual(nodes(modelSelect).filter(node => node.type === 'option').map(node => node.props.value), ['synthetic-model', 'other-model']);
  modelSelect.props.onChange({ target: { value: 'other-model' } });
  await ui.flush();
  only(ui.tree, node => node.type === 'select' && node.props.value === 'off').props.onChange({ target: { value: 'low' } });
  await ui.flush();
  assert.deepEqual(ui.calls.map(value => value.input), ['model-status', 'model 11 other-model', 'thinking 12 low']);
  assert.equal(only(ui.tree, node => node.type === 'input').props.value, '');
  assert.equal(button(ui.tree, 'wake').props.disabled, true);
  button(ui.tree, 'models').props.onClick();
  await ui.flush();
  assert.deepEqual(ui.calls.map(value => value.input), ['model-status', 'model 11 other-model', 'thinking 12 low', 'models']);
  ui.runtime.unmount();
  await ui.disposePlugin();
});
