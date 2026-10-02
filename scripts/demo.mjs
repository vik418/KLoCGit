import {mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {git,LocalGit} from '../server/git.mjs';
import {Engine,emptyState} from '../core/engine.mjs';
import {record} from '../core/hash.mjs';
const defaultRoot=fileURLToPath(new URL('../.demo/',import.meta.url));
export async function createDemo(root=defaultRoot,save=async()=>{}) {
  await rm(root,{recursive:true,force:true});await mkdir(path.join(root,'repositories'),{recursive:true});
  const state=emptyState();const adapter=await new LocalGit(root).init();const engine=new Engine(state,adapter,save);
  for(const id of ['checkout-api','storefront']){
    const cwd=path.join(root,id);await mkdir(cwd,{recursive:true});await git(cwd,['init','--quiet','-b','main']);
    await writeFile(path.join(cwd,id==='checkout-api'?'checkout.json':'client.json'),JSON.stringify(id==='checkout-api'?{accepts:'dollars',retry:{strategy:'fixed',maxAttempts:2},requestIds:false,metrics:false}:{sends:'dollars',roundAt:'client'},null,2)+'\n');
    if(id==='checkout-api'){await writeFile(path.join(cwd,'tracing.json'),JSON.stringify({requestIds:false},null,2)+'\n');await writeFile(path.join(cwd,'metrics.json'),JSON.stringify({metrics:false},null,2)+'\n');}
    await writeFile(path.join(cwd,'README.md'),`# ${id}\n\nNorthstar checkout baseline. Standard Git repository.\n`);await git(cwd,['add','.']);await git(cwd,['commit','--quiet','-m','Baseline checkout application']);const head=await git(cwd,['rev-parse','HEAD']);
    await git(root,['clone','--quiet','--bare',cwd,adapter.dir({id})]);state.repositories.push({id,name:id,canonical_ref:'refs/heads/main',head,baseline:head,provider:'local-git',remote:adapter.dir({id}),description:id==='checkout-api'?'Payment service & checkout contracts':'Web client & currency presentation'});
  }
  const constraint=await record('constraint',{statement:'Retry attempts must be between one and five.',scope:['checkout-api'],version:1,kind:'checkable',check_ref:'platform:retry-budget-v1'});state.constraints.push({...constraint,active:true});
  const specs=[
    {key:'trace-a',repo:'checkout-api',producer:'Atlas',title:'Trace every checkout request',statement:'Attach a request identifier to checkout events.',patch:{requestIds:true},group:'duplicate'},
    {key:'trace-b',repo:'checkout-api',producer:'Mira',title:'Add checkout request identifiers',statement:'Make checkout failures traceable through request IDs.',patch:{requestIds:true},group:'duplicate'},
    {key:'metrics',repo:'checkout-api',producer:'CI / reliability',title:'Instrument checkout latency',statement:'Expose independent checkout timing metrics.',patch:{metrics:true},group:'compatible'},
    {key:'retry-fixed',repo:'checkout-api',producer:'Atlas',title:'Use fixed-interval retries',statement:'Prefer predictable retries for short-lived failures.',patch:{retry:{strategy:'fixed',maxAttempts:3}},group:'decision'},
    {key:'retry-backoff',repo:'checkout-api',producer:'Rowan',title:'Use exponential backoff',statement:'Reduce pressure on the payment provider during outages.',patch:{retry:{strategy:'exponential',maxAttempts:4}},group:'decision'},
    {key:'api-cents',repo:'checkout-api',producer:'Mira',title:'Accept integer cents in the API',statement:'Remove floating-point arithmetic from the payment service.',patch:{accepts:'cents'},group:'interaction'},
    {key:'client-round',repo:'storefront',producer:'Rowan',title:'Round checkout amounts in the client',statement:'Keep dollars on the wire and normalize decimal amounts in the client.',patch:{roundAt:'wire'},group:'interaction'},
    {key:'docs',repo:'storefront',producer:'Git client',title:'Document the checkout contract',statement:'Provenance was not supplied by this producer.',docs:true,unknown:true,group:'included'}
  ];
  const start=performance.now();
  // Five independent producers work in isolated clones, concurrently. Producers may emit multiple proposals.
  const producers=[...new Set(specs.map(s=>s.producer))];
  await Promise.all(producers.map(async producer=>{for(const s of specs.filter(s=>s.producer===producer)){
    const repo=engine.repo(s.repo);const cwd=path.join(root,'producers',s.key);await mkdir(path.dirname(cwd),{recursive:true});await git(root,['clone','--quiet',adapter.dir(repo),cwd]);await git(cwd,['checkout','--quiet','-b',s.key]);
    if(s.docs)await writeFile(path.join(cwd,'README.md'),'# Storefront\n\nThe checkout client and API must use the same currency unit.\n\nCanonical changes are coordinated separately from Git.\n');
    else {const filename=s.patch.requestIds?'tracing.json':s.patch.metrics?'metrics.json':s.repo==='checkout-api'?'checkout.json':'client.json';const baseline=JSON.parse(await adapter.file(repo,repo.baseline,filename));await writeFile(path.join(cwd,filename),JSON.stringify({...baseline,...s.patch},null,2)+'\n');}
    await git(cwd,['add','.']);await git(cwd,['commit','--quiet','-m',s.title]);await git(cwd,['push','--quiet','origin',s.key]);s.head=await git(cwd,['rev-parse','HEAD']);
  }}));
  // Serialize metadata after independent producers finish; real API uses the same workspace boundary.
  for(const s of specs){const r=await engine.ingest({repo:s.repo,ref:`refs/heads/${s.key}`,after:s.head},{title:s.title,statement:s.statement,producer:s.producer,provenance_state:s.unknown?'unknown':'declared'});s.revision=r.revision_id;const revision=engine.revision(s.revision);await engine.validate(revision.id,engine.repo(s.repo),revision.tree_hash,revision.head_commit,{[s.repo]:engine.repo(s.repo).head});}
  const get=k=>specs.find(s=>s.key===k).revision;
  const compatible=await record('rel',{from_revision:get('metrics'),to_revision:get('trace-a'),type:'compatible_candidate',confidence:1,basis:'observed',analyzer_version:'git-compose-v1',evidence_refs:[],observation:'Candidate must be checked on the actual composed tree; no global compatibility claim.'});state.relationships.push(compatible);
  const alternative=await record('rel',{from_revision:get('retry-fixed'),to_revision:get('retry-backoff'),type:'alternative',confidence:null,basis:'declared',analyzer_version:'demo-scenario-v1',evidence_refs:[],observation:'Scenario declares two retry-policy alternatives; trusted checks do not choose architecture.'});state.relationships.push(alternative);
  const interaction=await adapter.interaction(engine.repo('checkout-api'),specs.find(s=>s.key==='api-cents').head,engine.repo('storefront'),specs.find(s=>s.key==='client-round').head);
  const interEvidence=await record('ev',{subject_ref:[get('api-cents'),get('client-round')],tree_hash:engine.revision(get('api-cents')).tree_hash,type:'cross-repository-contract',subject_trees:{'checkout-api':engine.revision(get('api-cents')).tree_hash,storefront:engine.revision(get('client-round')).tree_hash},config_hash:adapter.configHash,result:interaction,source:'platform-owned currency fixture',created_at:new Date().toISOString(),validity_heads:Object.fromEntries(state.repositories.map(r=>[r.id,r.head])),constraint_versions:[constraint.id],claim:'The exact API/client composition fails one $10 checkout contract scenario.'});state.evidence.push(interEvidence);
  state.relationships.push(await record('rel',{from_revision:get('api-cents'),to_revision:get('client-round'),type:'conflicts_with',confidence:1,basis:'observed',analyzer_version:'currency-contract-v1',evidence_refs:[interEvidence.id],observation:'Textually mergeable across repositories; $10 becomes 10 cents under the combined contract.'}));
  state.decisionComponents=[
    {id:'retry-policy',title:'How should checkout recover from failures?',kind:'Architectural choice',summary:'Two valid retry policies trade predictable latency for provider protection. Choose the behavior we want to ship.',intent:'Make checkout resilient without overwhelming the payment provider.',scope:['checkout-api'],revision_ids:[get('retry-fixed'),get('retry-backoff'),get('trace-a'),get('trace-b'),get('metrics')],status:'open',assumptions:[{value:'Payment failures are transient and requests are safe to retry.',basis:'declared',source:'Demo scenario',unresolved:true}],alternatives:[
      {id:'backoff',title:'Exponential backoff',description:'Space retries progressively to protect the payment provider.',tradeoff:'May increase time to recovery',repo:'checkout-api',revision_ids:[get('retry-backoff'),get('trace-a'),get('trace-b'),get('metrics')],recommended:true},
      {id:'fixed',title:'Fixed-interval retries',description:'Use predictable intervals for fast recovery from short outages.',tradeoff:'Higher request pressure during an outage',repo:'checkout-api',revision_ids:[get('retry-fixed'),get('trace-a'),get('trace-b'),get('metrics')]}
    ],included:['Request tracing · one implementation, two proposal histories','Checkout latency metrics · composed and checked']},
    {id:'currency-contract',title:'Where should currency normalization live?',kind:'Semantic interaction',summary:'The API cents proposal and the client dollars proposal merge cleanly, but disagree on the wire contract. Together, a $10 checkout becomes 10 cents.',intent:'Preserve the checkout amount across the client and API boundary.',scope:['checkout-api','storefront'],revision_ids:[get('api-cents'),get('client-round'),get('docs')],status:'open',interaction_evidence_id:interEvidence.id,assumptions:[],alternatives:[
      {id:'keep-dollars',title:'Keep dollars at the API boundary',description:'Keep the established API contract and round amounts in the client.',tradeoff:'Defer the integer-cents API proposal',repo:'storefront',revision_ids:[get('client-round'),get('docs')],recommended:true},
      {id:'review-api',title:'Keep the current currency behavior',description:'Apply the contract documentation and defer both behavior changes.',tradeoff:'Integer-cents migration needs a coordinated follow-up',repo:'storefront',revision_ids:[get('docs')]}
    ],included:['Contract documentation · unknown provenance, included for explicit review'],deferred_note:'Applying the API cents change alone fails the existing client contract and is not offered as a safe composition.'}
  ];
  // Every offered alternative has an actual Git composition and trusted evidence.
  for(const c of state.decisionComponents)await engine.refreshDecision(c.id);
  state.workspace.producers=producers;state.metrics.analysisLatencyMs=Math.round(performance.now()-start);await engine.audit('demo.ready','coordinator',{producers:5,proposals:8,decisions:2});await save(state);return {engine,state,adapter,specs};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const {state}=await createDemo(defaultRoot,async s=>writeFile(path.join(defaultRoot,'state.json'),JSON.stringify(s,null,2)));console.log(JSON.stringify({repositories:state.repositories.map(r=>({repo:r.id,clone:r.remote})),proposals:state.proposals.length,humanDecisions:state.decisionComponents.length,compressionRatio:2/8},null,2));}
