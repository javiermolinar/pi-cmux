import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,rmSync,existsSync,readFileSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve,dirname } from 'node:path';
import { test } from 'node:test';
import { loadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';

test('isolated HOME install includes panel asset and every runtime import; only doctor is exposed outside cmux through actual Pi loader',async t=>{
 const surface=process.env.CMUX_SURFACE_ID;delete process.env.CMUX_SURFACE_ID;
 t.after(()=>{if(surface===undefined)delete process.env.CMUX_SURFACE_ID;else process.env.CMUX_SURFACE_ID=surface});
 const home=mkdtempSync(join(tmpdir(),'pi-cmux-install-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const run=args=>execFileSync(process.execPath,[resolve('install.mjs'),...args],{env:{PATH:process.env.PATH,HOME:home},encoding:'utf8'});
 run([]);const dest=join(home,'.pi/agent/packages/pi-cmux'),entry=join(dest,'extensions/index.ts'),visited=new Set();
 assert.ok(existsSync(join(dest,'lib/messaging/runtime.ts')));assert.ok(existsSync(join(dest,'lib/orientation/runtime.ts')));
 function walk(file){if(visited.has(file))return;visited.add(file);assert.ok(existsSync(file),`installed import missing: ${file}`);const source=readFileSync(file,'utf8');for(const match of source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g)){const dependency=resolve(dirname(file),match[1]);if(/\.(ts|js|mjs)$/.test(dependency))walk(dependency);else assert.ok(existsSync(dependency))}}
 walk(entry);assert.ok(visited.size>=25);
 const result=await loadExtensions([entry],home);assert.deepEqual(result.errors,[]);assert.equal(result.extensions.length,1);
 assert.deepEqual([...result.extensions[0].commands.keys()],['cmdoctor']);
 for(const key of ['tools','shortcuts','handlers'])assert.equal(result.extensions[0][key].size,0,`${key} must stay empty outside cmux`);
 assert.ok(existsSync(join(dest,'examples/sidebars/agent-state-panel.js')));
 assert.equal(existsSync(join(dest,'examples/sidebars/launch-pi.mjs')),false);
 assert.equal(existsSync(join(dest,'examples/sidebars/install-agent-state-panel.mjs')),false);
 const helper=join(dest,'lib/panel-install.mjs');
 const output=execFileSync(process.execPath,['--input-type=module','-e',`import {readBundledPanel,renderInstalledPanel} from ${JSON.stringify(helper)}; console.log(readBundledPanel().length); if(/const PI_PANEL_LAUNCH\\s*=/.test(renderInstalledPanel()))throw Error('launch config leaked')`],{encoding:'utf8',cwd:home});
 assert.ok(Number(output.trim())>1000);
 const settings=()=>JSON.parse(readFileSync(join(home,'.pi/agent/settings.json'),'utf8'));assert.deepEqual(settings().packages,['./packages/pi-cmux']);run([]);assert.deepEqual(settings().packages,['./packages/pi-cmux']);
 for(const name of ['plans','tests','node_modules','.pi'])assert.equal(existsSync(join(dest,name)),false);
 run(['--remove']);assert.equal(existsSync(dest),false);assert.deepEqual(settings().packages,[]);
});
