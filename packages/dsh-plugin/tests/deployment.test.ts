import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const file = (path: string) => readFileSync(new URL('../../../' + path, import.meta.url), 'utf8');

test('default deployment runs only Dawn with DSH interaction; no Pi installation, runtime or extension copy', () => {
  const docker = file('Dockerfile');
  assert.match(docker, /FROM \$\{NODE_IMAGE\}/);
  assert.match(docker, /USER node/);
  assert.match(docker, /CMD \["serve"\]/);
  assert.match(docker, /COPY docker\//);
  assert.match(docker, /COPY package\.json LICENSE/);
  assert.doesNotMatch(docker, /PI_VERSION|\/opt\/pi|pi-extension|npm install|apt-get|\/work|\/home\/node\/\.pi/);
  assert.doesNotMatch(file('.dockerignore'), /^!packages\/pi-extension/m);
  assert.match(file('.dockerignore'), /^!docker\/bridge-request\.ts$/m);
});

test('Compose retains original subject volume only without deleting legacy volumes or opening ports', () => {
  const compose = file('compose.yaml');
  assert.deepEqual([...compose.matchAll(/^\s+- ([-a-z0-9]+):(\/[^\s]+)$/gm)].map(match => [match[1], match[2]]), [['dawn-data', '/data']]);
  assert.doesNotMatch(compose, /^\s*(?:pi-home|pi-work|PI_VERSION|ports|network_mode|privileged):/m);
  assert.match(compose, /Legacy pi-home\/pi-work volumes.*never delete them automatically/);
  assert.match(compose, /restart: "no"/);
  assert.match(compose, /stop_grace_period: 45s/);
  assert.match(compose, /test: \["CMD", "dawn-container", "status"\]/);
});

test('launcher returns after readiness and advertises DSH without any interactive client dispatch', () => {
  const script = file('start.sh');
  assert.doesNotMatch(script, /\bPi\b|\/dawn|dawn-container pi|compose (?:down|rm)/);
  assert.match(script, /DSH/);
  assert.match(script, /compose run --rm --no-deps dawn setup\s+compose up -d --no-build dawn/);
  assert.match(script, /\[\[ ! -t 0 \|\| ! -t 1 \]\]/);
  assert.match(script, /attempt<5/);
  assert.deepEqual(script.split('\n').filter(line => /^\s*(?:if )?compose exec/.test(line)).map(line => line.trim()), [
    'if compose exec -T dawn dawn-container status >/dev/null 2>&1; then ready=true; break; fi',
  ]);
  assert.match(script, /查询状态/);
  assert.match(script, /exit 0\s*$/);
});

test('container entry removes Pi dispatch but preserves explicit setup, service, learning and DSH bridge', () => {
  const entry = file('docker/entrypoint.sh');
  assert.doesNotMatch(entry, /^\s*pi\)|exec pi|pi-extension|DAWN_ENDPOINT|DAWN_TOKEN_FILE/m);
  assert.match(entry, /bridge-request\)\s+\[ "\$#" -eq 0 \] \|\| exit 1\s+exec node "\$APP\/docker\/bridge-request\.ts"/);
  assert.match(entry, /serve\)\s+\[ "\$#" -eq 0 \] \|\| exit 1\s+node "\$MANAGE" verify-files/);
  assert.match(entry, /learning-run\)\s+\[ "\$#" -eq 0 \] \|\| exit 1\s+node "\$MANAGE" verify-files/);
  assert.match(entry, /Initialization refused: database or service token already exists/);
});

test('new plugin installs default to Docker and README teaches DSH rather than Pi interaction', () => {
  assert.match(file('packages/dsh-plugin/cordis.patch.yml'), /connection: docker/);
  assert.match(file('packages/dsh-plugin/src/index.js'), /connection: Schema.union\(\['docker', 'http'\]\).default\('docker'\)/);
  const readme = file('README.md');
  assert.match(readme, /当前交互入口是 DSH 插件，不使用 Pi/);
  assert.match(readme, /就绪后返回终端/);
  assert.doesNotMatch(readme, /\/dawn (?:status|wake|say)|进入容器Pi|再进入 Pi|Pi输入框|Pi 输入框/);
  assert.match(readme, /不需要 `\/quit`/);
  assert.match(readme, /\*\*全部留空\*\*/);
});
