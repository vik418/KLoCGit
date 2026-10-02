import {Engine,emptyState} from '../core/engine.mjs';
import {ArtifactsGit} from './artifacts.mjs';
import {DomainError,hash,record} from '../core/hash.mjs';
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
async function authenticated(request,secret){if(!secret)return false;const value=request.headers.get('Authorization')??'';const [a,b]=await Promise.all([hash(value),hash('Bearer '+secret)]);return a===b;}
export class WorkspaceCoordinator {
 constructor(ctx,env){this.ctx=ctx;this.env=env;this.ready=ctx.blockConcurrencyWhile(async()=>{const state=await ctx.storage.get('state')??emptyState();state.workspace.mode='artifacts';state.workspace.producers??=[];this.engine=new Engine(state,new ArtifactsGit(env),async state=>ctx.storage.put('state',state));await this.engine.recover();});}
 async fetch(request){await this.ready;return this.engine.serial(async()=>{try{
   const url=new URL(request.url),input=request.method==='GET'?{}:await request.json();const engine=this.engine;
   if(url.pathname==='/api/workspace'&&request.method==='GET')return json(await engine.view());
   if(url.pathname==='/internal/push'){const fork=engine.state.forks.find(f=>f.id===input.event.repo);if(fork)input.event={...input.event,repo:fork.repo,source_repo:fork.id};if(!engine.state.repositories.some(r=>r.id===input.event.repo))return json({ignored:true,reason:'UNREGISTERED_REPOSITORY'});return json(await engine.ingest(input.event,input.metadata??{}));}
   if(url.pathname==='/api/repositories'&&request.method==='POST'){
    const name=input.name;if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name??''))throw new DomainError('INVALID_REPO','Use a valid repository name');
    if(engine.state.repositories.some(r=>r.id===name))throw new DomainError('REPO_EXISTS','Repository is already registered',409);
    if(input.create){const created=await this.env.ARTIFACTS.create(name,{description:String(input.description??''),setDefaultBranch:'main'});await engine.audit('repository.created',this.env.ACTOR_ID,{repo:name});await engine.save(engine.state);return json({name:created.name,remote:created.remote,needs_initial_commit:true,instruction:'Push an initial main commit using a separately provisioned scoped Git token, then register this repository without create:true.'},201);}
    const capability=await this.env.ARTIFACTS.get(name);let info;try{info=await capability.info();}finally{capability[Symbol.dispose]?.();}
    const repo={id:name,name,canonical_ref:'refs/heads/'+info.defaultBranch,provider:'cloudflare-artifacts',remote:info.remote};const head=await engine.git.ref(repo,repo.canonical_ref);Object.assign(repo,{head,baseline:head});engine.state.repositories.push(repo);await engine.audit('repository.registered',this.env.ACTOR_ID,{repo:name,head});await engine.save(engine.state);return json(repo,201);
   }
   if(url.pathname==='/api/repositories/fork'&&request.method==='POST'){
    const source=engine.repo(input.source);if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(input.name??''))throw new DomainError('INVALID_REPO','Use a valid fork name');
    const capability=await this.env.ARTIFACTS.get(source.id);let result;try{result=await capability.fork(input.name,{description:String(input.description??''),defaultBranchOnly:true});}finally{capability[Symbol.dispose]?.();}
    engine.state.forks.push({id:result.name,repo:source.id,base_commit:source.head});
    await engine.audit('repository.forked',this.env.ACTOR_ID,{source:source.id,fork:result.name});await engine.save(engine.state);
    // A token is minted by Artifacts but never returned through provenance or the generic UI.
    return json({id:result.id,name:result.name,remote:result.remote,defaultBranch:result.defaultBranch},201);
   }
   if(url.pathname==='/api/events'&&request.method==='POST')return json(await engine.ingest(input.event,input.metadata??{}));
   if(url.pathname==='/api/decisions'&&request.method==='POST'){
    if(!Array.isArray(input.revision_ids)||!input.revision_ids.length||!Array.isArray(input.alternatives)||input.alternatives.length<2)throw new DomainError('INVALID_DECISION','A decision needs immutable revisions and at least two alternatives');
    const revisions=input.revision_ids.map(id=>engine.revision(id));const component={id:'component_'+await hash({revisions:input.revision_ids,alternatives:input.alternatives,title:input.title}),title:String(input.title).slice(0,200),summary:String(input.summary??'').slice(0,2000),kind:'Human review',intent:String(input.intent??''),scope:[...new Set(revisions.map(r=>r.repo))],revision_ids:input.revision_ids,status:'open',assumptions:[],included:[],alternatives:input.alternatives.map((a,i)=>({id:String(i),title:String(a.title).slice(0,200),description:String(a.description??''),tradeoff:String(a.tradeoff??''),repo:engine.repo(a.repo).id,revision_ids:a.revision_ids.map(id=>engine.revision(id).id)}))};
    if(engine.state.decisionComponents.some(c=>c.id===component.id))return json(engine.component(component.id));engine.state.decisionComponents.push(component);await engine.refreshDecision(component.id);return json(component,201);
   }
   const match=url.pathname.match(/^\/api\/decisions\/([^/]+)\/(refresh|resolve)$/);if(match&&request.method==='POST')return json(match[2]==='refresh'?await engine.refreshDecision(match[1]):await engine.resolve(match[1],input,this.env.ACTOR_ID));
   throw new DomainError('NOT_FOUND','Endpoint not found',404);
  }catch(e){return json({error:e.code??'INTERNAL_ERROR',message:e.status?e.message:'Coordination failed. Git remains available.',details:e.details??{}},e.status??500);}});}
}
export default {
 async fetch(request,env){const url=new URL(request.url);if(!url.pathname.startsWith('/api/'))return env.ASSETS.fetch(request);
  const ingress=url.pathname==='/api/events';if(!await authenticated(request,ingress?env.INGEST_TOKEN:env.AUTH_TOKEN)||(!ingress&&!env.ACTOR_ID))return json({error:'UNAUTHENTICATED',message:'A configured authenticated actor is required.'},401);
  if(request.method!=='GET'&&request.headers.get('Origin')&&new URL(request.headers.get('Origin')).origin!==url.origin)return json({error:'FORBIDDEN_ORIGIN'},403);
  if(Number(request.headers.get('Content-Length')??0)>1000000)return json({error:'PAYLOAD_TOO_LARGE'},413);
  if(request.method!=='GET'&&request.method!=='HEAD'){const raw=await request.text();if(new TextEncoder().encode(raw).length>1000000)return json({error:'PAYLOAD_TOO_LARGE'},413);request=new Request(request,{body:raw});}
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(env.WORKSPACE_ID??'default')).fetch(request);
 },
 async queue(batch,env){for(const message of batch.messages){try{const event=message.body;if(event.type!=='cf.artifacts.repo.pushed'||event.source.namespace!==env.ARTIFACTS_NAMESPACE){message.ack();continue;}const stub=env.COORDINATOR.get(env.COORDINATOR.idFromName(env.WORKSPACE_ID??'default'));const response=await stub.fetch(new Request('https://coordinator/internal/push',{method:'POST',body:JSON.stringify({event:{repo:event.source.repoName,ref:event.payload.ref,before:event.payload.before,after:event.payload.after}})}));if(!response.ok)throw new Error('Ingestion not acknowledged');message.ack();}catch{message.retry();}}}
};
