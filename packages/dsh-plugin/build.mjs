import { stripTypeScriptTypes } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, relative, extname, isAbsolute } from 'node:path';

/**
 * Dependency-free Node24 build. Copies only reachable own code, never credentials/data.
 * @param {string | URL} destination
 */
export async function buildPlugin(destination = new URL('./lib/', import.meta.url)) {
  const project = fileURLToPath(new URL('../../', import.meta.url));
  const packageRoot = fileURLToPath(new URL('./', import.meta.url));
  const out = typeof destination === 'string' ? resolve(destination) : fileURLToPath(destination);
  const visited = new Set();
  async function emit(source) {
    const rel = relative(project, source);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Build import escapes project');
    const target = resolve(out, rel.replace(/\.ts$/, '.js'));
    if (visited.has(source)) return;
    visited.add(source);
    let code = await readFile(source, 'utf8');
    if (extname(source) === '.ts') code = stripTypeScriptTypes(code, { mode: 'strip' });
    const imports = [...code.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)];
    for (const match of imports) {
      const specifier = match[1];
      if (!/\.(?:js|ts)$/.test(specifier)) throw new Error('Unsupported build import');
      await emit(resolve(dirname(source), specifier));
    }
    code = code.replace(/((?:from\s*|import\s*)['"]\.[^'"]+)\.ts(['"])/g, '$1.js$2');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, code, 'utf8');
  }
  await emit(resolve(packageRoot, 'src/index.js'));
  await mkdir(out, { recursive: true });
  await writeFile(resolve(out, 'LICENSE'), await readFile(resolve(project, 'LICENSE'), 'utf8'));
  await writeFile(resolve(out, 'index.js'), "export { Config, inject, apply } from './packages/dsh-plugin/src/index.js';\n");
  // The Client is a lazy DSH module factory using host React. No bundler or CDN.
  const contract = (await readFile(resolve(packageRoot, 'src/remote-contract.js'), 'utf8')).replace(/^export /gm, '');
  const client = (await readFile(resolve(packageRoot, 'src/client.js'), 'utf8')).replace(/^import .*?;\r?\n/gm, '').replace(/^export /gm, '');
  const en = JSON.parse(await readFile(resolve(packageRoot, 'locale/en.json'), 'utf8'));
  const zh = JSON.parse(await readFile(resolve(packageRoot, 'locale/zh.json'), 'utf8'));
  await writeFile(resolve(out, 'client.js'), `window.__ModuleLoader__.load({\n id: '@shuguang/dsh-plugin',\n factory: (require) => {\n const React = require('react');\n${contract}\n${client}\n return createClientPlugin(React, ${JSON.stringify({ en, zh })});\n }\n});\n`, 'utf8');
  return { output: out, modules: visited.size };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await buildPlugin();
  console.log(`Built Shuguang Host and Client (${result.modules} own modules).`);
}
