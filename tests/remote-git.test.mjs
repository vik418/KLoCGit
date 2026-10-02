import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {git} from '../server/git.mjs';
import {RemoteGit} from '../server/remote-git.mjs';
import {createBridge} from '../server/bridge.mjs';
import {DomainError} from '../core/hash.mjs';

// Actual Git transport against a local bare remote. The Artifacts HTTPS/auth
// transport boundary is substituted; these tests do not establish live access.
class TestRemote extends RemoteGit {
  entry(id){if(id!=='app')throw new Error('Unknown test repository');return {remote:this.testRemote,validation_profile:'checkout-effects-v2'};}
  async remote(id,args){
    try{const output=await git(this.dir({id}),args);if(this.loseReply&&args[0]==='push'&&args.some(a=>a.startsWith('--force-with-lease=')))throw new Error('Lost successful canonical reply');return output;}
    catch{throw new DomainError('REMOTE_GIT_FAILED','Test remote outcome is uncertain',503);}
  }
}
async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'decision-remote-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),remote=path.join(root,'remote.git'),cache=path.join(root,'cache');await mkdir(source);
  await git(source,['init','--quiet','-b','main']);await writeFile(path.join(source,'app.txt'),'baseline\n');await git(source,['add','.']);await git(source,['commit','--quiet','-m','Baseline']);const base=await git(source,['rev-parse','HEAD']);
  await git(root,['clone','--quiet','--bare',source,remote]);await git(source,['checkout','--quiet','-b','producer']);await writeFile(path.join(source,'app.txt'),'producer change\n');await git(source,['add','.']);await git(source,['commit','--quiet','-m','Proposal\n\nDecision-Task: task-a\nDecision-Context: context-a']);const head=await git(source,['rev-parse','HEAD']);await git(source,['push','--quiet',remote,'HEAD:refs/heads/producer']);
  const adapter=await new TestRemote(cache,{repositories:{}}).init();adapter.testRemote=remote;
  return {root,source,remote,cache,base,head,adapter,repo:{id:'app',canonical_ref:'refs/heads/main'},revision:{repo:'app',base_commit:base,head_commit:head}};
}
test('remote composition persists the actual candidate before return and survives complete cache loss',async t=>{
  const f=await fixture(t),candidate=await f.adapter.compose(f.repo,f.base,[f.revision]);
  assert.equal(await git(f.remote,['rev-parse',candidate.retention_ref]),candidate.commit);assert.equal(await git(f.remote,['rev-parse','refs/heads/main']),f.base);
  await rm(f.cache,{recursive:true,force:true});await f.adapter.ensureCommit('app',candidate.commit);
  assert.equal(await git(f.adapter.dir(f.repo),['rev-parse',`${candidate.commit}^{tree}`]),candidate.tree);
  assert.deepEqual(await f.adapter.trailers(f.repo,f.head),[{key:'Decision-Task',value:'task-a'},{key:'Decision-Context',value:'context-a'}]);
});
test('real Git lease rejects an external canonical push without overwriting it',async t=>{
  const f=await fixture(t),candidate=await f.adapter.compose(f.repo,f.base,[f.revision]);const tree=await git(f.remote,['rev-parse',`${f.base}^{tree}`]),external=await git(f.remote,['commit-tree',tree,'-p',f.base,'-m','External client']);await git(f.remote,['update-ref','refs/heads/main',external,f.base]);
  assert.equal(await f.adapter.cas(f.repo,f.base,candidate.commit),false);assert.equal(await git(f.remote,['rev-parse','refs/heads/main']),external);
});
test('a lost reply after real successful Git lease remains an uncertain outcome for exact-target recovery',async t=>{
  const f=await fixture(t),candidate=await f.adapter.compose(f.repo,f.base,[f.revision]);f.adapter.loseReply=true;
  await assert.rejects(()=>f.adapter.cas(f.repo,f.base,candidate.commit),e=>e.code==='REMOTE_GIT_FAILED');assert.equal(await git(f.remote,['rev-parse','refs/heads/main']),candidate.commit);
});
test('bridge health is authenticated and reports bounded sandbox readiness and exact configuration',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'decision-bridge-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const previous=process.env.BRIDGE_TEST_GIT_TOKEN;process.env.BRIDGE_TEST_GIT_TOKEN='inert-test';t.after(()=>{if(previous===undefined)delete process.env.BRIDGE_TEST_GIT_TOKEN;else process.env.BRIDGE_TEST_GIT_TOKEN=previous;});
  const {server,adapter}=await createBridge({manifest:{cacheDirectory:root,repositories:{app:{remote:'https://test.artifacts.cloudflare.net/git/test/app.git',tokenEnv:'BRIDGE_TEST_GIT_TOKEN',validation_profile:'checkout-effects-v2'}}},token:'test-bridge-token'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const url=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url+'/health')).status,401);const response=await fetch(url+'/health',{headers:{Authorization:'Bearer test-bridge-token'}});assert.equal(response.status,200);const health=await response.json();assert.equal(health.configHash,adapter.configHash);assert.equal(typeof health.sandbox.available,'boolean');
  const stale=await fetch(url+'/cas',{method:'POST',headers:{Authorization:'Bearer test-bridge-token','Content-Type':'application/json'},body:JSON.stringify({configHash:'obsolete',repo:'app'})});assert.equal(stale.status,409);assert.equal((await stale.json()).error,'CONFIG_STALE');
  const profile=await fetch(url+'/validate',{method:'POST',headers:{Authorization:'Bearer test-bridge-token','Content-Type':'application/json'},body:JSON.stringify({configHash:adapter.configHash,repo:'app',validation_profile:'context-document-v1'})});assert.equal(profile.status,409);assert.equal((await profile.json()).error,'VALIDATION_PROFILE_MISMATCH');
});
