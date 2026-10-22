import { REMOTE_INFO, PACKAGE_NAME } from './remote-contract.js';

/** Browser entry is wrapped by build.mjs; React is supplied by DSH, not bundled. */
export function createClientPlugin(React, dictionaries) {
  const h = React.createElement;
  const NS = 'shuguang';
  const PANEL = 'shuguang';
  function Icon({ size = 18 }) {
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
      h('path', { d: 'M3 19h18M5 16a7 7 0 0 1 14 0M12 2v4M3 7l3 3M21 7l-3 3', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }));
  }
  function Panel({ t, run }) {
    const [input, setInput] = React.useState('');
    const [revision, setRevision] = React.useState('');
    const [output, setOutput] = React.useState('');
    const [state, setState] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const pending = React.useRef(null);
    const mounted = React.useRef(false);
    React.useEffect(() => {
      mounted.current = true;
      return () => { mounted.current = false; pending.current?.abort(); };
    }, []);
    async function execute(command) {
      if (pending.current) return;
      const controller = new AbortController();
      pending.current = controller;
      setBusy(true); setError(''); setOutput('');
      try {
        const response = await run(command, controller.signal);
        controller.signal.throwIfAborted();
        if (!mounted.current) return;
        if (response.type === 'error') {
          setError(`${t('failure')} (${response.code})`);
        } else if (response.type === 'status') {
          setRevision(String(response.revision));
          setOutput(`${response.lifecycle} · revision=${response.revision} · instance=${response.runtime.instanceId}`);
        } else if (response.type === 'model') {
          setState(response.state);
          setOutput(JSON.stringify(response.state, null, 2));
        } else if (response.type === 'reply') {
          setOutput(response.text);
          // A successful dialogue changes the subject revision. Never reuse it for wake/sleep.
          setRevision('');
        } else throw new Error('Unexpected response');
      } catch {
        if (mounted.current) setError(t('failure'));
      } finally {
        if (pending.current === controller) pending.current = null;
        if (mounted.current) setBusy(false);
      }
    }
    const button = (key, onClick, disabled = busy) => h('button', { type: 'button', onClick, disabled }, t(key));
    const lifecycle = kind => {
      if (!/^(0|[1-9]\d*)$/.test(revision) || !Number.isSafeInteger(Number(revision))) return;
      void execute(`${kind} ${revision}`);
    };
    return h('section', { className: 'shuguang-panel', 'aria-label': t('title') },
      h('style', null, styles),
      h('header', null, h(Icon, { size: 24 }), h('h1', null, t('title'))),
      h('p', null, t('intro')),
      h('p', { className: 'shuguang-muted' }, t('boundary')),
      h('div', { className: 'shuguang-actions' },
        button('status', () => void execute('status')),
        button('modelStatus', () => void execute('model-status')),
        button('models', () => void execute('models'))),
      h('p', { className: 'shuguang-muted' }, t('directoryNotice')),
      h('div', { className: 'shuguang-actions' },
        h('label', null, t('revision'), h('input', { value: revision, inputMode: 'numeric', maxLength: 16, disabled: busy, onChange: e => setRevision(e.target.value) })),
        button('wake', () => lifecycle('wake'), busy || !revision),
        button('sleep', () => lifecycle('sleep'), busy || !revision)),
      h('p', { className: 'shuguang-muted' }, t('revisionNotice')),
      state && h('div', { className: 'shuguang-actions' },
        h('label', null, t('model'), h('select', { value: state.model, disabled: busy, onChange: e => void execute(`model ${state.selectionRevision} ${e.target.value}`) },
          [...new Set([state.model, ...state.models])].map(id => h('option', { key: id, value: id }, id)))),
        h('label', null, t('thinking'), h('select', { value: state.thinking, disabled: busy, onChange: e => void execute(`thinking ${state.selectionRevision} ${e.target.value}`) },
          state.levels.map(level => h('option', { key: level, value: level }, level))))),
      h('p', { className: 'shuguang-muted' }, t('thinkingNotice')),
      h('form', { onSubmit: e => { e.preventDefault(); if (input.trim()) void execute(`say ${input.trim()}`); } },
        h('label', null, t('message'), h('textarea', { value: input, maxLength: 16000, disabled: busy, rows: 4, onChange: e => setInput(e.target.value) })),
        h('p', { className: 'shuguang-muted' }, t('cost')),
        h('div', { className: 'shuguang-actions' },
          h('button', { type: 'submit', disabled: busy || !input.trim() }, t('send')),
          button('cancel', () => pending.current?.abort(), !busy))),
      error && h('p', { role: 'alert' }, error),
      h('div', { role: 'status', 'aria-live': 'polite', 'aria-busy': busy }, busy ? t('pending') : ''),
      h('pre', { className: 'shuguang-output', tabIndex: 0 }, output),
      h('footer', { className: 'shuguang-muted' }, t('learning')));
  }
  return {
    inject: ['remote', 'slots', 'locale'],
    apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, dictionaries));
      let disposed = false;
      const lifetime = new AbortController();
      let activeCall;
      let following;
      let unmountRemote;
      const ready = Promise.resolve(ctx.remote.$mount(REMOTE_INFO)).then(unmount => {
        unmountRemote = unmount;
        if (disposed) return;
        // Namespace services are separate Cordis dependencies, not properties
        // available on the original fiber merely because $mount has completed.
        following = ctx.inject(['remote.shuguang'], child => {
          const available = new AbortController();
          const call = async (input, signal) => {
            const combined = AbortSignal.any([signal, available.signal]);
            combined.throwIfAborted();
            const result = await child.remote.shuguang.command(input, combined);
            combined.throwIfAborted();
            return result;
          };
          activeCall = call;
          child.effect(() => () => {
            available.abort();
            if (activeCall === call) activeCall = undefined;
          });
        });
      });
      // A rejected mount is retained and reported only on an explicit action.
      ready.catch(() => {});
      ctx.effect(() => async () => {
        disposed = true; lifetime.abort();
        await ready.catch(() => {});
        await following?.dispose();
        await unmountRemote?.();
      });
      const run = async (input, signal) => {
        const combined = AbortSignal.any([signal, lifetime.signal]);
        combined.throwIfAborted();
        await ready;
        combined.throwIfAborted();
        if (disposed) throw new Error('Disposed');
        if (!activeCall) throw new Error('Shuguang namespace unavailable');
        const result = await activeCall(input, combined);
        combined.throwIfAborted();
        if (!result.ok) throw new Error('Shuguang remote request failed');
        // Decode is bounded by the mounted descriptor; domain envelope checked on Host.
        return JSON.parse(result.value);
      };
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL, locale: NS, inject: () => ({ run }) }, Panel));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, label: () => ctx.locale.bind(NS)('title'), locale: NS }, Icon));
    },
  };
}

const styles = `
.shuguang-panel {box-sizing:border-box;height:100%;overflow:auto;padding:28px;max-width:960px;margin:auto;color:var(--dsw-alias-label-primary);font:inherit;}
.shuguang-panel header,.shuguang-actions {display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.shuguang-panel h1 {font-size:22px;margin:0;}.shuguang-panel p {line-height:1.6;}
.shuguang-muted {color:var(--dsw-alias-label-secondary);font-size:13px;}
.shuguang-panel button,.shuguang-panel input,.shuguang-panel select,.shuguang-panel textarea {font:inherit;color:inherit;background:var(--dsw-alias-surface-primary);border:1px solid var(--dsw-alias-border-primary);border-radius:6px;padding:8px 12px;}
.shuguang-panel button {cursor:pointer;}.shuguang-panel button:hover {background:var(--dsw-alias-interactive-bg-hover);}
.shuguang-panel :disabled {opacity:.5;cursor:not-allowed;}.shuguang-panel label {display:flex;flex-direction:column;gap:6px;min-width:0;}
.shuguang-panel textarea {box-sizing:border-box;width:100%;resize:vertical;}.shuguang-panel select {max-width:100%;}.shuguang-panel form {margin-top:24px;}
.shuguang-panel :focus-visible {outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px;}
.shuguang-output {white-space:pre-wrap;overflow-wrap:anywhere;max-height:40vh;overflow:auto;font:inherit;padding:16px;border:1px solid var(--dsw-alias-border-primary);border-radius:8px;}
@media(max-width:600px){.shuguang-panel{padding:16px;}.shuguang-actions>*{max-width:100%;}}
`;
