import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import Schema from '@deepseek-ai/schemastery';
import { DawnBridge } from './bridge.ts';
import { createHostPlugin } from './host.js';

// Paths are explicit Host-side configuration, never a Client RPC argument.
export const Config = Schema.object({
  connection: Schema.union(['docker', 'http']).default('docker').description('Docker: exec requests in an existing local dawn container. HTTP: direct loopback endpoint.'),
  dockerProjectDir: Schema.string().default('').description('Docker mode: absolute repository directory on the DSH Host containing compose.yaml. No automatic container start.'),
  dockerContext: Schema.string().default('default').description('Explicit Docker context: default or desktop-linux, pointing at the same local Docker engine as your running dawn container.'),
  dockerProjectName: Schema.string().default('').description('Optional existing Compose project name. Use the original project/volumes; never create another subject to fix connection errors.'),
  endpoint: Schema.string().default('').description('Existing Dawn endpoint: http://127.0.0.1:PORT. No automatic startup.'),
  tokenFile: Schema.string().default('').description('Absolute private Dawn service token file on the DSH Host (POSIX permissions). Choose exactly one of tokenFile and tokenEnv.'),
  tokenEnv: Schema.string().default('').description('Explicit SHUGUANG_*_TOKEN environment variable name, not its value. Useful on Windows. Must be present in the DSH Host process before launch.'),
});
export const { inject, apply } = createHostPlugin(TypertRemoteService, DawnBridge);
