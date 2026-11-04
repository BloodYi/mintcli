import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { IPty } from 'node-pty';
import { createOfficialLoginService } from '../official-login.service.js';

test('agy uses a private OAuth home, accepts a code and imports without replacing the selected account', async () => {
  let data: (text: string) => void = () => {};
  let exit: (event: { exitCode: number }) => void = () => {};
  let privateHome = '', written = '', imported = 0;
  const service = createOfficialLoginService({ busy: async()=>[], spawn: (_command, _args, options) => {
    privateHome=options!.env!.HOME!;
    return { onData: callback=>{data=callback;return{dispose(){}}}, onExit: callback=>{exit=callback;return{dispose(){}}}, write: value=>{written+=value}, kill:()=>{exit({exitCode:1})} } as IPty;
  }, importAgy: async body=>{
    const payload=body as {alias:string;token_json:string;switch_now:boolean};
    assert.equal(payload.switch_now,false);assert.match(payload.alias,/New-[a-f0-9]{8}$/);assert.equal(JSON.parse(payload.token_json).token.access_token,'fixture-secret-private');
    imported++;return Response.json({id:'new-account',email:'new@example.test'});
  } });
  const flow=await service.start('antigravity','New');
  assert.notEqual(privateHome,process.env.HOME);
  assert.equal((await service.start('antigravity','New')).id,flow.id);
  data('Select login method:\r\n > 1. Google OAuth');assert.equal(written,'\r');
  data('https://accounts.google.com.evil.test/steal?token=secret\n');assert.equal(service.status(flow.id).url,undefined);
  data('https://accounts.google.com/o/oauth2/auth?state=fixture\nIf you aren\'t automatically redirected, paste the authorization code below:\n');
  assert.equal(service.status(flow.id).acceptsCode,true);
  assert.throws(()=>service.submit(flow.id,'bad\ncode'));
  service.submit(flow.id,'fixture-return-code');assert.equal(written,'\rfixture-return-code\r');
  data('authorization code...'); assert.equal(service.status(flow.id).acceptsCode,false);
  assert.throws(()=>service.submit(flow.id,'duplicate-code'));
  const tokenFile=path.join(privateHome,'.gemini/antigravity-cli/antigravity-oauth-token');await fs.mkdir(path.dirname(tokenFile),{recursive:true});
  await fs.writeFile(tokenFile,JSON.stringify({token:{access_token:'fixture-secret-private'}}),{mode:0o600});
  for(let n=0;n<100&&!service.status(flow.id).authorized;n++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(service.status(flow.id).authorized,true);assert.equal(imported,1);
  assert.equal(JSON.stringify(service.status(flow.id)).includes('fixture-secret-private'),false);
  data('https://accounts.google.com/o/oauth2/auth?state=late');assert.equal(service.status(flow.id).status,'authorized');
});

test('native login never starts over a busy CLI and cancellation stops a private authorization', async () => {
  let spawns=0;
  const busy=createOfficialLoginService({busy:async()=>['cursor'],spawn:()=>{spawns++;throw Error('must not spawn')}});
  await assert.rejects(busy.start('cursor','New'));assert.equal(spawns,0);
  let killed=false;
  const service=createOfficialLoginService({busy:async()=>[],spawn:()=>({onData:()=>({dispose(){}}),onExit:()=>({dispose(){}}),write(){},kill(){killed=true}} as unknown as IPty)});
  const flow=await service.start('antigravity','New');
  assert.equal(service.cancel(flow.id).status,'cancelled');assert.equal(killed,true);
  assert.throws(()=>service.submit(flow.id,'late-code'));
});
