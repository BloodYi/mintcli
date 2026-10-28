import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexProviderModels } from '../list/codex/codex-models.provider.js';
import { Codex } from '@openai/codex-sdk';
import type { Thread, ThreadOptions } from '@openai/codex-sdk';
import { codexRuntime } from '../list/codex/codex-runtime.provider.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';
import { CodexProviderAuth } from '../list/codex/codex-auth.provider.js';

test('native model and auth adapters follow the selected credential home rather than the default account or static catalog', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'codex-selected-')); const previous = process.env.CODEX_CONNECTIONS_ROOT; process.env.CODEX_CONNECTIONS_ROOT = root;
 const original = globalThis.fetch;
 globalThis.fetch = (async (_url, init) => { const token = (init?.headers as Record<string,string>).Authorization; return new Response(JSON.stringify({ models: [{ slug: token.endsWith('A') ? 'live-a' : 'live-b', visibility: 'list' }] })); }) as typeof fetch;
 try {
  const connections: { id: string; name: string; kind: string; home: string }[] = [];
  for (const [id, token] of [['one','A'],['two','B']]) { const home = path.join(root,id); await mkdir(home); await writeFile(path.join(home,'auth.json'),JSON.stringify({ tokens:{ access_token:token,id_token:'header.'+Buffer.from(JSON.stringify({email:id+'@example.test'})).toString('base64url')+'.signature' }})); await writeFile(path.join(home,'config.toml'),'model="retired-model"'); connections.push({id,name:id,kind:'chatgpt',home}); }
  const select = async (activeId:string) => writeFile(path.join(root,'store.json'),JSON.stringify({activeId,connections}));
  const models = new CodexProviderModels(); const auth = new CodexProviderAuth();
  await select('one'); assert.equal((await models.getSupportedModels()).DEFAULT,'live-a'); assert.equal((await auth.getStatus()).email,'one@example.test'); assert.equal((await models.getCurrentActiveModel()).model,'live-a');
  await select('two'); assert.deepEqual((await models.getSupportedModels()).OPTIONS.map(x=>x.value),['live-b']); assert.equal((await auth.getStatus()).email,'two@example.test');
 } finally { globalThis.fetch = original; if(previous===undefined)delete process.env.CODEX_CONNECTIONS_ROOT;else process.env.CODEX_CONNECTIONS_ROOT=previous; }
});


test('an old tab or resumed session cannot send a retired model or another account catalog', async t => {
 const root = await mkdtemp(path.join(os.tmpdir(),'codex-runtime-catalog-')); const previous=process.env.CODEX_CONNECTIONS_ROOT;process.env.CODEX_CONNECTIONS_ROOT=root;
 const home=path.join(root,'one');await mkdir(home);await writeFile(path.join(home,'auth.json'),JSON.stringify({tokens:{access_token:'captured-account'}}));
 await writeFile(path.join(root,'store.json'),JSON.stringify({activeId:'one',connections:[{id:'one',kind:'chatgpt',name:'One',home}]}));
 const original=globalThis.fetch;globalThis.fetch=(async()=>new Response(JSON.stringify({models:[{slug:'current-live',visibility:'list'}]}))) as typeof fetch;
 let selected:ThreadOptions|undefined;
 t.mock.method(Codex.prototype,'startThread',(options?:ThreadOptions)=>{selected=options;return {id:'fake-thread',runStreamed:async()=>({events:(async function*(){yield {type:'thread.started',thread_id:'fake-thread'};})()})} as unknown as Thread;});
 const context:ProviderRuntimeContext={resolveProviderSessionId:()=>null,resolveResumeModel:async()=> 'retired-model',getProviderModels:async()=>({OPTIONS:[{value:'wrong-account',label:'Wrong'}],DEFAULT:'wrong-account'}),normalizeMessage:()=>[],isProviderInstalled:async()=>true};
 try {await codexRuntime.run('test',{connectionId:'one',cwd:root},{isWebSocketWriter:true,send:()=>{}},context);assert.equal(selected?.model,'current-live');}
 finally{globalThis.fetch=original;if(previous===undefined)delete process.env.CODEX_CONNECTIONS_ROOT;else process.env.CODEX_CONNECTIONS_ROOT=previous;}
});
