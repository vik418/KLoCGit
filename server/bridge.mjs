// Trusted executor for Cloudflare Artifacts. Deploy behind an authenticated service binding.
// It executes Git and platform checks only; never runs repository-owned scripts.
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {LocalGit,git} from './git.mjs';
import {hash,DomainError} from '../core/hash.mjs';
const exec=promisify(execFile);
export class RemoteGit extends LocalGit {
 constructor(root,manifest){super(root);this.manifest=manifest;}
 entry(id){const entry=this.manifest.repositories[id];if(!entry||!/^https:\/\//.test(entry.remote)||!entry.tokenEnv||!process.env[entry.tokenEnv])throw new DomainError('REPO_NOT_CONFIGURED','Executor has no scoped repository credential',503);return entry;}
 async remote(id,args){const entry=this.entry(id);const env={...process.env,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_VALUE_0:'Authorization: Bearer '+process.env[entry.tokenEnv]};try{return (await exec('git',args,{cwd:this.dir({id}),env,maxBuffer:4*1024*1024})).stdout.trim();}catch{throw new DomainError('REMOTE_GIT_FAILED','Authenticated Git operation failed; credentials are not included in diagnostics',503);}}
 async ensure(id){this.entry(id);await mkdir(this.dir({id}),{recursive:true});try{await git(this.dir({id}),['rev-parse','--is-bare-repository']);}catch{await git(this.dir({id}),['init','--bare','--quiet']);}await this.remote(id,['fetch','--quiet',this.entry(id).remote,'+refs/heads/*:refs/heads/*']);}
 async compose(repo,head,revisions){await this.ensure(repo.id);for(const revision of revisions){if(revision.source_repo&&revision.source_repo!==repo.id){await this.ensure(revision.source_repo);await git(this.dir(repo),['fetch','--quiet',this.dir({id:revision.source_repo}),revision.head_commit]);}}return super.compose(repo,head,revisions);}
 async validate(repo,commit,constraints,validityHeads){for(const id of Object.keys(validityHeads))await this.ensure(id);return super.validate(repo,commit,constraints,validityHeads);}
 async cas(repo,expected,commit){
  const remote=this.entry(repo.id).remote;
  try{await this.remote(repo.id,['push','--porcelain',`--force-with-lease=${repo.canonical_ref}:${expected}`,remote,`${commit}:${repo.canonical_ref}`]);return true;}catch(e){
   const refs=await this.remote(repo.id,['ls-remote',remote,repo.canonical_ref]);const observed=refs.split(/\s/)[0];if(observed&&observed!==expected)return false;throw e;
  }
 }
}
if(import.meta.url===new URL(process.argv[1],'file:').href){
 const manifestPath=process.env.GIT_EXECUTOR_MANIFEST;if(!manifestPath||!process.env.GIT_BRIDGE_TOKEN)throw new Error('GIT_EXECUTOR_MANIFEST and GIT_BRIDGE_TOKEN must be configured.');
 const manifest=JSON.parse(await readFile(manifestPath,'utf8'));const adapter=await new RemoteGit(manifest.cacheDirectory,manifest).init();let tail=Promise.resolve();
 const server=http.createServer(async(req,res)=>{const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};try{
  if(await hash(req.headers.authorization??'')!==await hash('Bearer '+process.env.GIT_BRIDGE_TOKEN))throw new DomainError('UNAUTHENTICATED','Trusted service credential required',401);
  let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1000000)throw new DomainError('PAYLOAD_TOO_LARGE','Request exceeds 1MB',413);}const input=JSON.parse(raw);if(input.configHash!==adapter.configHash)throw new DomainError('CONFIG_STALE','Executor validation configuration changed',409);
  const job=tail.then(async()=>{const repo={id:input.repo,canonical_ref:input.ref??'refs/heads/main'};adapter.entry(repo.id);if(req.url==='/compose')return adapter.compose(repo,input.head,input.revisions);if(req.url==='/validate')return adapter.validate(repo,input.commit,input.constraints,input.validityHeads);if(req.url==='/cas'){if(!/^refs\/heads\/[\w./-]+$/.test(repo.canonical_ref)||repo.canonical_ref.includes('..'))throw new DomainError('INVALID_REF','Invalid canonical ref');return {updated:await adapter.cas(repo,input.expected,input.commit)};}throw new DomainError('NOT_FOUND','Unknown executor operation',404);});tail=job.catch(()=>{});send(200,await job);
 }catch(e){send(e.status??500,{error:e.code??'EXECUTOR_FAILED',message:e.status?e.message:'Trusted executor failed'});}});
 server.listen(Number(process.env.GIT_EXECUTOR_PORT??8788),'127.0.0.1',()=>console.log(JSON.stringify({executor:'ready',configHash:adapter.configHash})));
}
