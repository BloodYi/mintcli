import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
import { connectionService, resolveCodexConnection } from '../connections.service.js';

const waitFor = async (ready: () => boolean) => { for (let n=0;n<100;n++) { if (ready()) return; await new Promise(resolve=>setTimeout(resolve,20)); } throw new Error('login did not settle'); };

test('browser OAuth accepts only its own callback, forwards codes to the fixed loopback CLI, and keeps existing accounts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-browser-login-'));
  const keys = ['HOME','CODEX_CONNECTIONS_ROOT','PATH','MINTCLI_MANAGED_CLIS'] as const;
  const previous = Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  const originalFetch = globalThis.fetch;
  const ids: string[] = [];
  try {
    process.env.HOME=root;process.env.CODEX_CONNECTIONS_ROOT=path.join(root,'store');process.env.PATH=root+path.delimiter+process.env.PATH;process.env.MINTCLI_MANAGED_CLIS='0';
    fs.writeFileSync(path.join(root,'codex'), `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');\nconsole.log('https://auth.openai.com/oauth/authorize?state=fixture-state&redirect_uri='+encodeURIComponent('http://localhost:1455/auth/callback'));\nconst timer=setInterval(()=>{if(fs.existsSync(path.join(process.env.CODEX_HOME,'auth.json'))){clearInterval(timer);process.exit(0)}},20);\n`,{mode:0o700});
    const old = await connectionService.save({ name:'Existing', kind:'chatgpt' }); ids.push(old.id);
    const next = await connectionService.save({ name:'New', kind:'chatgpt' }); ids.push(next.id);
    const before = connectionService.list().activeId;
    await connectionService.startLogin(next.id);
    await waitFor(()=>connectionService.loginStatus(next.id).status==='pending');
    const pending = connectionService.loginStatus(next.id);
    assert.equal(pending.method,'browser');assert.equal(pending.acceptsCode,true);
    let calls=0;
    globalThis.fetch=(async input=>{calls++;const url=new URL(String(input));assert.equal(url.origin,'http://127.0.0.1:1455');
      if(url.pathname==='/success'){assert.equal(url.search,'','never forward credential-bearing redirect query parameters');return new Response('ok');}
      assert.equal(url.pathname,'/auth/callback');assert.equal(url.searchParams.get('code'),'fixture-code');assert.equal(url.searchParams.get('state'),'fixture-state');
      const home=resolveCodexConnection(next.id).home;fs.writeFileSync(path.join(home,'auth.json'),JSON.stringify({tokens:{access_token:'fixture-access-private'}}),{mode:0o600});return new Response(null,{status:302,headers:{location:'http://localhost:1455/success?access_token=private-redirect-token'}});}) as typeof fetch;
    await assert.rejects(connectionService.submitLoginCode(next.id,'http://169.254.169.254:1455/auth/callback?state=fixture-state&code=fixture-code'));
    await assert.rejects(connectionService.submitLoginCode(next.id,'http://localhost:1455/auth/callback?state=wrong&code=fixture-code'));
    assert.equal(calls,0);
    await connectionService.submitLoginCode(next.id,'http://localhost:1455/auth/callback?state=fixture-state&code=fixture-code');
    await waitFor(()=>connectionService.loginStatus(next.id).authorized);assert.equal(calls,2);
    assert.equal(connectionService.list().activeId,before);assert.equal(connectionService.list().connections.length,2);
    assert.equal(JSON.stringify(connectionService.loginStatus(next.id)).includes('fixture-access-private'),false);
    fs.writeFileSync(path.join(root,'codex'),`#!${process.execPath}\nsetTimeout(()=>process.exit(1),20)\n`,{mode:0o700});
    await connectionService.startLogin(next.id);
    await waitFor(()=>connectionService.loginStatus(next.id).status==='error');
    assert.equal(connectionService.loginStatus(next.id).authorized,false,'a failed reauthorization must not report the old credentials as a new login');
    assert.equal(connectionService.list().connections.find(item=>item.id===next.id)?.authorized,true,'the existing credential remains saved');
    let foreignRequests=0;const foreign=createServer(socket=>{foreignRequests++;socket.end()});
    await new Promise<void>(resolve=>foreign.listen(1455,'127.0.0.1',resolve));
    try { await assert.rejects(connectionService.startLogin(next.id),/回调端口/);assert.equal(foreign.listening,true);assert.equal(foreignRequests,0,'never send the CLI cancellation request to another login listener'); }
    finally { await new Promise<void>(resolve=>foreign.close(()=>resolve())); }


  } finally {
    globalThis.fetch=originalFetch;
    for(const id of ids) {try{connectionService.cancelLogin(id)}catch{}}
    for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value}
    fs.rmSync(root,{recursive:true,force:true});
  }
});
