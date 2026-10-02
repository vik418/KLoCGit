import http from 'node:http';
import {readFile,writeFile,rename,mkdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer as createViteServer} from 'vite';
import {Engine} from '../core/engine.mjs';
import {LocalGit} from './git.mjs';
import {createDemo,produceWork} from '../scripts/demo.mjs';
import {record,DomainError} from '../core/hash.mjs';
const project=fileURLToPath(new URL('../',import.meta.url));const root=process.env.DECISION_GIT_ROOT?path.resolve(process.env.DECISION_GIT_ROOT):path.join(project,'.demo-v2');const stateFile=path.join(root,'state.json');
const localActor=process.env.LOCAL_ACTOR_ID??'demo-owner';const ownerToken=process.env.LOCAL_OWNER_TOKEN;
const save=async state=>{await mkdir(root,{recursive:true});await writeFile(stateFile+'.tmp',JSON.stringify(state,null,2));await rename(stateFile+'.tmp',stateFile);};
let engine;
let existingState;
try{existingState=JSON.parse(await readFile(stateFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
if(existingState){engine=new Engine(existingState,await new LocalGit(root).init(),save);await engine.recover();}
else{
  // Missing coordination metadata must not erase intact Git repositories.
  try{await stat(path.join(root,'repositories'));throw new DomainError('WORKSPACE_METADATA_MISSING','Existing Git repositories need their coordination metadata restored; startup will preserve them.',503);}catch(error){if(error.code!=='ENOENT')throw error;}
  ({engine}=await createDemo(root,save,{pending:true}));
}
const vite=await createViteServer({root:project,server:{middlewareMode:true},appType:'spa'});
async function body(req){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1000000)throw new DomainError('PAYLOAD_TOO_LARGE','Request exceeds 1MB',413);}try{return raw?JSON.parse(raw):{};}catch{throw new DomainError('INVALID_JSON','Request body must be JSON');}}
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
function principal(req){
  if(ownerToken&&req.headers.authorization!==`Bearer ${ownerToken}`)throw new DomainError('UNAUTHENTICATED','The configured local owner credential is required',401);
  if(!localActor.trim())throw new DomainError('UNAUTHENTICATED','A configured local owner identity is required',401);
  return localActor;
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');if(!url.pathname.startsWith('/api/'))return vite.middlewares(req,res,()=>{res.writeHead(404);res.end();});
  try{
    const actor=principal(req);
    if(req.method!=='GET'&&req.headers.origin){const origin=new URL(req.headers.origin);if(origin.host!==req.headers.host)throw new DomainError('FORBIDDEN_ORIGIN','Cross-origin mutations are not allowed',403);}
    const input=req.method==='GET'?{}:await body(req);
    // This process has one fixed local principal. Client payloads cannot select
    // actors; LOCAL_OWNER_TOKEN optionally authenticates API callers. Production
    // uses the Worker's configured owner credential.
    const result=await engine.serial(async()=>{
      if(url.pathname==='/api/workspace'&&req.method==='GET')return engine.view();
      if(url.pathname==='/api/tasks'&&req.method==='GET')return {tasks:engine.state.tasks};
      if(url.pathname==='/api/tasks'&&req.method==='POST')return engine.prepareTask(input.task??input,actor);
      const taskMatch=url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(answer|assume))?$/);
      if(taskMatch&&req.method==='GET'&&!taskMatch[2]){const task=engine.state.tasks.find(t=>t.task.id===taskMatch[1]);if(!task)throw new DomainError('TASK_NOT_FOUND','Task not found',404);return task;}
      if(taskMatch&&req.method==='POST'&&taskMatch[2])return engine.resolveTask(taskMatch[1],{value:input.value,rationale:input.rationale},actor,taskMatch[2]==='assume');
      if(url.pathname==='/api/demo/reset'&&req.method==='POST'){const next=await createDemo(root,save,{pending:true});engine.state=next.state;engine.git=next.adapter;return engine.view();}
      if(url.pathname==='/api/demo/start'&&req.method==='POST'){
        const task=engine.state.tasks[0];if(!task?.authorization)throw new DomainError('CONTEXT_REQUIRED','Answer or explicitly assume the retrieved-policy question before starting the coordinated producers.',409);
        const validity=await engine.contextValidity({sources:[task.source]});if(validity.status!=='current')throw new DomainError('CONTEXT_STALE','The policy changed after task review. Prepare and review the current context before starting producers.',409,{reason:validity.reason});
        await produceWork(engine,root);return engine.view();
      }
      if(url.pathname==='/api/analysis'&&req.method==='POST')return engine.analyzeWork({actor,refresh:input.refresh===true});
      if(url.pathname==='/api/recover'&&req.method==='POST'){await engine.recover();return engine.view();}
      if(url.pathname==='/api/demo/stale'&&req.method==='POST'){await engine.git.externalAdvance(engine.repo('checkout-api'));await engine.syncHeads();return engine.view();}
      if(url.pathname==='/api/demo/constraint'&&req.method==='POST'){const old=engine.state.constraints.find(c=>c.active);if(!old)throw new DomainError('CONSTRAINT_NOT_FOUND','No active constraint is available',404);old.active=false;const {id,active,...data}=old;const c=await record('constraint',{...data,version:old.version+1});engine.state.constraints.push({...c,active:true});await engine.audit('constraint.updated',actor,{constraint_id:c.id});await save(engine.state);return engine.view();}
      const match=url.pathname.match(/^\/api\/decisions\/([^/]+)\/(resolve|refresh)$/);
      if(match&&req.method==='POST'){if(match[2]==='refresh')return engine.refreshDecision(match[1]);return engine.resolve(match[1],input,actor);}
      if(url.pathname==='/api/diff'&&req.method==='GET'){const rev=engine.revision(url.searchParams.get('revision'));return {diff:await engine.git.diff(engine.repo(rev.repo),rev.base_commit,rev.head_commit)};}
      if(url.pathname==='/api/events'&&req.method==='POST')return engine.ingest(input.event,input.metadata);
      throw new DomainError('NOT_FOUND','Endpoint not found',404);
    });json(res,200,result);
  }catch(e){json(res,e.status??500,{error:e.code??'INTERNAL_ERROR',message:e.status?e.message:'The operation failed. Git repositories remain available.',details:e.details??{}});}
});
const port=Number(process.env.PORT??5173);server.listen(port,'0.0.0.0',()=>console.log(`Converge local demo: http://localhost:${server.address().port}\nCanonical repositories: ${path.join(root,'repositories')}\nOwner identity: ${localActor}; ${ownerToken?'credential required':'local demo session'}`));
async function shutdown(){server.close();await vite.close();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
