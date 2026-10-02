import http from 'node:http';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer as createViteServer} from 'vite';
import {Engine} from '../core/engine.mjs';
import {LocalGit} from './git.mjs';
import {createDemo} from '../scripts/demo.mjs';
import {record,DomainError} from '../core/hash.mjs';
const project=fileURLToPath(new URL('../',import.meta.url));const root=path.join(project,'.demo');const stateFile=path.join(root,'state.json');
const save=async state=>{await mkdir(root,{recursive:true});await writeFile(stateFile+'.tmp',JSON.stringify(state,null,2));await rename(stateFile+'.tmp',stateFile);};
let engine;
try{const state=JSON.parse(await readFile(stateFile,'utf8'));engine=new Engine(state,await new LocalGit(root).init(),save);await engine.recover();}catch{({engine}=await createDemo(root,save));}
const vite=await createViteServer({root:project,server:{middlewareMode:true},appType:'spa'});
async function body(req){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1000000)throw new DomainError('PAYLOAD_TOO_LARGE','Request exceeds 1MB',413);}try{return raw?JSON.parse(raw):{};}catch{throw new DomainError('INVALID_JSON','Request body must be JSON');}}
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');if(!url.pathname.startsWith('/api/'))return vite.middlewares(req,res,()=>{res.writeHead(404);res.end();});
  try{
    if(req.method!=='GET'&&req.headers.origin){const origin=new URL(req.headers.origin);if(origin.host!==req.headers.host)throw new DomainError('FORBIDDEN_ORIGIN','Cross-origin mutations are not allowed',403);}
    const input=req.method==='GET'?{}:await body(req);
    // Local demo principal is explicit. Production Worker derives actor from a configured secret credential.
    const result=await engine.serial(async()=>{
      if(url.pathname==='/api/workspace'&&req.method==='GET')return engine.view();
      if(url.pathname==='/api/demo/reset'&&req.method==='POST'){const next=await createDemo(root,save);engine.state=next.state;engine.git=next.adapter;return engine.view();}
      if(url.pathname==='/api/demo/stale'&&req.method==='POST'){await engine.git.externalAdvance(engine.repo('checkout-api'));await engine.syncHeads();return engine.view();}
      if(url.pathname==='/api/demo/constraint'&&req.method==='POST'){const old=engine.state.constraints.find(c=>c.active);old.active=false;const c=await record('constraint',{statement:old.statement,scope:old.scope,version:old.version+1,kind:old.kind,check_ref:old.check_ref});engine.state.constraints.push({...c,active:true});await engine.audit('constraint.updated','demo-owner',{constraint_id:c.id});await save(engine.state);return engine.view();}
      const match=url.pathname.match(/^\/api\/decisions\/([^/]+)\/(resolve|refresh)$/);
      if(match&&req.method==='POST'){if(match[2]==='refresh')return engine.refreshDecision(match[1]);return engine.resolve(match[1],input,'demo-owner');}
      if(url.pathname==='/api/diff'&&req.method==='GET'){const rev=engine.revision(url.searchParams.get('revision'));return {diff:await engine.git.diff(engine.repo(rev.repo),rev.base_commit,rev.head_commit)};}
      if(url.pathname==='/api/events'&&req.method==='POST')return engine.ingest(input.event,input.metadata);
      throw new DomainError('NOT_FOUND','Endpoint not found',404);
    });json(res,200,result);
  }catch(e){json(res,e.status??500,{error:e.code??'INTERNAL_ERROR',message:e.status?e.message:'The operation failed. Git repositories remain available.',details:e.details??{}});}
});
const port=Number(process.env.PORT??5173);server.listen(port,'0.0.0.0',()=>console.log(`Converge local demo: http://localhost:${port}\nCanonical repositories: ${path.join(root,'repositories')}`));
process.on('SIGTERM',()=>server.close());
