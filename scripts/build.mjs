import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('dist/client', { recursive: true });
const result = await build({ entryPoints: ['src/client/index.tsx'], bundle: true, platform: 'browser', format: 'cjs', target: 'es2022', external: ['react', 'react-dom', 'react/jsx-runtime'], write: false, loader: { '.css': 'text' } });
const source = result.outputFiles[0].text;
await writeFile('dist/client/index.js', `window.__ModuleLoader__.load({id: 'dsh-plugin-redmine', factory(require) { const module = {exports:{}}; const exports = module.exports;\n${source}\nreturn module.exports; }});\n//# sourceURL=dsh-plugin-redmine.js\n`);
