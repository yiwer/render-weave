/** 标识本次运行的引擎文件、锁文件及实际安装的生产依赖（含 WASM）。 */
import { createHash } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function rendererBuildId(): Promise<string> {
  const engine = dirname(fileURLToPath(import.meta.url));
  const root = dirname(engine);
  const hash = createHash('sha256');
  const add = (label: string, bytes: Uint8Array) => {
    hash.update(`${Buffer.byteLength(label)}:${label}:${bytes.length}:`); hash.update(bytes);
  };
  async function tree(dir: string, label: string, engineOnly = false): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const file = join(dir, entry.name), key = `${label}/${entry.name}`;
      if (entry.isDirectory()) await tree(file, key, engineOnly);
      else if (entry.isFile() && (!engineOnly || (entry.name.endsWith(engine.endsWith('dist') ? '.js' : '.ts') && !entry.name.endsWith('.d.ts')))) add(key, await readFile(file));
      else if (entry.isSymbolicLink()) throw new Error(`构建文件不能是符号链接：${key}`);
    }
  }
  await tree(engine, 'engine', true);
  add('package.json', await readFile(join(root, 'package.json')));
  add('package-lock.json', await readFile(join(root, 'package-lock.json')));
  const visited = new Set<string>();
  async function dependencies(packageDir: string, label: string): Promise<void> {
    const metadata = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
    const require = createRequire(join(packageDir, 'package.json'));
    for (const name of Object.keys(metadata.dependencies ?? {}).sort()) {
      // package.json may be hidden by exports; locate the owning package from its resolved entry.
      let resolved: string;
      try { resolved = require.resolve(`${name}/package.json`); }
      catch { resolved = require.resolve(name); }
      let dir = dirname(resolved);
      while (true) {
        try { if (JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).name === name) break; } catch { /* ascend */ }
        const parent = dirname(dir); if (parent === dir) throw new Error(`无法定位生产依赖 ${name}`); dir = parent;
      }
      dir = await realpath(dir);
      if (visited.has(dir)) continue;
      visited.add(dir);
      const key = `${label}/${name}`;
      await tree(dir, key);
      await dependencies(dir, key);
    }
  }
  await dependencies(root, 'dependencies');
  return `sha256:${hash.digest('hex')}`;
}
