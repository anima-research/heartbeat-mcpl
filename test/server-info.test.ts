import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serverWithHost } from './scripted-host.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

for (const viaSymlink of [false, true]) {
  test(`a host that starts the built server ${viaSymlink ? 'through a symlink, as npm links a bin,' : 'by its path'} from another directory is told the package's release version`, async (t) => {
    for (const mcpl of [true, false]) {
      const h = await serverWithHost(() => ({}), { mcpl, viaSymlink });
      t.after(h.close);
      assert.equal(h.serverInfo.version, version, mcpl ? 'an MCPL host' : 'a plain MCP host');
    }
  });
}
