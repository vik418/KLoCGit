import {DurableObject} from 'cloudflare:workers';
import {hash} from '../core/hash.mjs';

const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const operations=new Set(['/compose','/validate','/cas','/profile','/trailers','/suite','/diff','/health']);
async function authorized(request,secret){return Boolean(secret)&&await hash(request.headers.get('Authorization')??'')===await hash('Bearer '+secret);}

// A separately deployed service binding routes to this named Container DO.
// Repository credentials stay in trusted processes; candidate code gets an empty environment.
export class GitExecutorContainer extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.tail=Promise.resolve();}
  serial(fn){const next=this.tail.then(fn);this.tail=next.catch(()=>{});return next;}
  async ready(){
    const container=this.ctx.container;
    if(!container)throw new Error('CONTAINER_UNAVAILABLE');
    if(!container.running){
      if(!this.env.GIT_EXECUTOR_MANIFEST_JSON||!this.env.GIT_REPOSITORY_TOKENS_JSON||!this.env.GIT_BRIDGE_TOKEN)throw new Error('EXECUTOR_UNCONFIGURED');
      const manifest=JSON.parse(this.env.GIT_EXECUTOR_MANIFEST_JSON),tokens=JSON.parse(this.env.GIT_REPOSITORY_TOKENS_JSON);
      const secrets={};
      for(const entry of Object.values(manifest.repositories??{})){
        if(!/^[A-Z][A-Z0-9_]*$/.test(entry.tokenEnv??'')||!tokens[entry.tokenEnv])throw new Error('EXECUTOR_UNCONFIGURED');
        secrets[entry.tokenEnv]=tokens[entry.tokenEnv];
      }
      container.start({enableInternet:true,env:{...secrets,GIT_EXECUTOR_MANIFEST_JSON:JSON.stringify(manifest),GIT_BRIDGE_TOKEN:this.env.GIT_BRIDGE_TOKEN,GIT_EXECUTOR_HOST:'0.0.0.0',GIT_EXECUTOR_PORT:'8788'}});
      this.ctx.waitUntil(container.monitor().catch(()=>this.ctx.storage.put('lastContainerFailureAt',Date.now())));
    }
    const port=container.getTcpPort(8788),deadline=Date.now()+30000;
    while(Date.now()<deadline){
      try{const response=await port.fetch('http://executor/health',{headers:{Authorization:'Bearer '+this.env.GIT_BRIDGE_TOKEN}});if(response.ok)return port;}catch{}
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    throw new Error('EXECUTOR_START_TIMEOUT');
  }
  async fetch(request){return this.serial(async()=>{
    const url=new URL(request.url);
    if(url.pathname.startsWith('/control/')){
      if(this.env.LIVE_TEST_ENABLED!=='true'||!await authorized(request,this.env.LIVE_TEST_TOKEN))return json({error:'UNAUTHENTICATED'},401);
      if(url.pathname==='/control/arm'&&request.method==='POST'){
        const input=await request.json();
        if(input.kind!=='drop-cas-response-once'||!input.repo||!input.expected)return json({error:'INVALID_TEST_FAULT'},400);
        await this.ctx.storage.put('armedFault',{kind:input.kind,repo:input.repo,expected:input.expected});
        await this.ctx.storage.delete('faultReceipt');return json({armed:true});
      }
      if(url.pathname==='/control/status'&&request.method==='GET')return json({armed:await this.ctx.storage.get('armedFault')??null,receipt:await this.ctx.storage.get('faultReceipt')??null});
      if(url.pathname==='/control/restart'&&request.method==='POST'){
        if(this.ctx.container?.running)await this.ctx.container.destroy();
        return json({restarted:true,disk:'ephemeral; candidate objects must have remote refs'});
      }
      return json({error:'NOT_FOUND'},404);
    }
    if(!operations.has(url.pathname)||!await authorized(request,this.env.GIT_BRIDGE_TOKEN))return json({error:'UNAUTHENTICATED'},401);
    if(request.method!==(url.pathname==='/health'?'GET':'POST'))return json({error:'METHOD_NOT_ALLOWED'},405);
    const body=request.method==='GET'?undefined:await request.text();
    if(body&&new TextEncoder().encode(body).length>1000000)return json({error:'PAYLOAD_TOO_LARGE'},413);
    try{
      const port=await this.ready();
      let fault;
      if(url.pathname==='/cas'&&body){
        const input=JSON.parse(body),armed=await this.ctx.storage.get('armedFault');
        if(armed&&armed.repo===input.repo&&armed.expected===input.expected){fault={repo:input.repo,expected:input.expected,target:input.commit};await this.ctx.storage.delete('armedFault');await this.ctx.storage.put('faultInFlight',fault);}
      }
      // Never retry an operation after forwarding it: a lost CAS reply is an uncertain outcome.
      const response=await port.fetch(new Request('http://executor'+url.pathname,{method:request.method,headers:request.headers,body}));
      if(fault){
        const result=await response.clone().json();
        await this.ctx.storage.put('faultReceipt',{...fault,updated:result.updated===true,status:response.status,created_at:new Date().toISOString()});
        await this.ctx.storage.delete('faultInFlight');
        if(response.ok&&result.updated===true)return json({error:'LIVE_TEST_RESPONSE_DROPPED',message:'The test gateway withheld the successful Git CAS response.'},503);
      }
      return response;
    }catch{return json({error:'EXECUTOR_UNAVAILABLE',message:'Trusted execution is unavailable; canonical advancement requires recovery if an operation was prepared.'},503);}
  });}
}

export default {async fetch(request,env){
  const control=new URL(request.url).pathname.startsWith('/control/');
  if(control&&(env.LIVE_TEST_ENABLED!=='true'||!await authorized(request,env.LIVE_TEST_TOKEN)))return json({error:'UNAUTHENTICATED'},401);
  if(!control&&!await authorized(request,env.GIT_BRIDGE_TOKEN))return json({error:'UNAUTHENTICATED'},401);
  return env.EXECUTOR.get(env.EXECUTOR.idFromName(env.WORKSPACE_ID??'default')).fetch(request);
}};
