import test from 'node:test';
import assert from 'node:assert/strict';
import {ArtifactsGit} from '../worker/artifacts.mjs';
import worker from '../worker/index.mjs';
test('untrusted __proto__ filenames remain visible in observed affected scope',async()=>{const binding={get:async()=>({readCommit:async h=>({hash:h,treeHash:h==='head'?'new':'old'}),readTree:async h=>h==='new'?[{name:'__proto__',type:'blob',mode:'100644',hash:'changed'}]:[],[Symbol.dispose](){}})};const adapter=new ArtifactsGit({ARTIFACTS:binding});const facts=await adapter.facts({id:'repo'},'head','base');assert.deepEqual(facts.scope,['__proto__']);});
test('missing immutable Artifacts objects return a bounded domain failure',async()=>{const adapter=new ArtifactsGit({ARTIFACTS:{get:async()=>({readCommit:async()=>null,[Symbol.dispose](){}})}});await assert.rejects(()=>adapter.facts({id:'repo'},'missing','base'),e=>e.code==='MISSING_COMMIT'&&e.status===404);});
test('canonical Artifacts operations fail closed without a trusted Git executor',async()=>{const adapter=new ArtifactsGit({});await assert.rejects(()=>adapter.cas({id:'repo',canonical_ref:'refs/heads/main'},'old','new'),e=>e.code==='GIT_EXECUTOR_UNAVAILABLE'&&e.status===503);});
test('production API requires authenticated identity before forwarding mutations',async()=>{const response=await worker.fetch(new Request('https://example/api/decisions/x/resolve',{method:'POST',body:'{}'}),{});assert.equal(response.status,401);});
