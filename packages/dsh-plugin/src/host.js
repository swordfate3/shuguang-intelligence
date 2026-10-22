import { TYPERT } from './remote-contract.js';

/** Adapter factory keeps DSH imports at the package entry, outside domain tests. */
export function createHostPlugin(TypertRemoteService, DawnBridge) {
  return {
    inject: ['typert'],
    apply(ctx, config = {}) {
      // No credentials or sockets at activation; the bridge reads only on command.
      const bridge = new DawnBridge(config);
      class ShuguangService extends TypertRemoteService {
        constructor(context) { super(context, 'shuguang'); }
        async command(input, signal) {
          // Do not allow a future global Remote grant to expose this owner's Dawn.
          if (this.ctx.invocation?.peer.principal.kind !== 'owner') {
            throw new Error('Shuguang requires the owner client');
          }
          return JSON.stringify(await bridge.command(input, signal));
        }
      }
      new ShuguangService(ctx);
      ctx.effect(() => () => bridge.dispose());
      ctx.effect(() => ctx.typert.register(TYPERT));
    },
  };
}
