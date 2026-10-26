import { cp, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
const root = await realpath('.dev');
const target = await realpath('.dev/dsh-home/profiles/redmine-dev/node_modules/dsh-plugin-redmine');
if (!target.startsWith(root + sep)) throw new Error('Isolated plugin must reside inside .dev');
await cp(resolve('dist'), resolve(target, 'dist'), { recursive: true, force: true });
console.log('Updated isolated DSH test bundle.');
