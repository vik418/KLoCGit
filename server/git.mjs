import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {hash,DomainError} from '../core/hash.mjs';
const exec=promisify(execFile);
export async function git(cwd,args,input) {
  if(input!==undefined){return new Promise((resolve,reject)=>{const p=execFile('git',args,{cwd,env:{...process.env,GIT_AUTHOR_NAME:'Converge',GIT_AUTHOR_EMAIL:'platform@local',GIT_COMMITTER_NAME:'Converge',GIT_COMMITTER_EMAIL:'platform@local'},maxBuffer:4*1024*1024},(err,stdout)=>err?reject(err):resolve(stdout.trim()));p.stdin.end(input);});}
  return (await exec('git',args,{cwd,env:{...process.env,GIT_AUTHOR_NAME:'Converge',GIT_AUTHOR_EMAIL:'platform@local',GIT_COMMITTER_NAME:'Converge',GIT_COMMITTER_EMAIL:'platform@local'},maxBuffer:4*1024*1024})).stdout.trim();
}
export class LocalGit {
  constructor(root){this.root=root;this.configHash='';}
  async init(){this.configHash=await hash({runner:'platform-structural-checks-v1',checks:['valid-json','currency-contract','retry-budget','documentation-readable'],source:await readFile(new URL('./git.mjs',import.meta.url),'utf8')});return this;}
  dir(repo){return path.join(this.root,'repositories',repo.id+'.git');}
  async ref(repo,ref){if(!/^refs\/heads\/[a-zA-Z0-9._/-]+$/.test(ref)||ref.includes('..'))throw new DomainError('INVALID_REF','A valid branch ref is required');try{return await git(this.dir(repo),['rev-parse','--verify',ref]);}catch{throw new DomainError('REF_NOT_FOUND','Git ref is unavailable',404);}}
  async facts(repo,head,base){if(!/^[a-f0-9]{40}$/.test(head)||!/^[a-f0-9]{40}$/.test(base))throw new DomainError('INVALID_COMMIT','Full immutable commit hashes are required');const tree=await git(this.dir(repo),['rev-parse',`${head}^{tree}`]);const scope=(await git(this.dir(repo),['diff','--name-only',base,head])).split('\n').filter(Boolean);return {head,base,tree,scope};}
  async compose(repo,head,revisions){
    const temp=await mkdtemp(path.join(os.tmpdir(),'converge-'));const cwd=path.join(temp,'work');
    try{await git(temp,['clone','--quiet','--no-hardlinks',this.dir(repo),cwd]);await git(cwd,['checkout','--quiet','--detach',head]);
      for(const revision of revisions){await git(cwd,['fetch','--quiet','origin',revision.head_commit]);const patch=await git(cwd,['diff','--binary',revision.base_commit,revision.head_commit]);if(!patch)continue;try{await git(cwd,['apply','--3way','--index'],patch+'\n');}catch{throw new DomainError('COMPOSITION_CONFLICT','The candidate has a textual conflict and requires conventional review',422);}}
      const tree=await git(cwd,['write-tree']);const baseTree=await git(cwd,['rev-parse',`${head}^{tree}`]);const commit=await git(cwd,['commit-tree',tree,'-p',head,'-m','Converge: immutable reviewed candidate']);await git(this.dir(repo),['fetch','--quiet',cwd,commit]);await git(this.dir(repo),['update-ref',`refs/converge/candidates/${commit}`,commit]);return {tree,commit,baseTree};
    }finally{await rm(temp,{recursive:true,force:true});}
  }
  async file(repo,commit,name){try{return await git(this.dir(repo),['show',`${commit}:${name}`]);}catch{return null;}}
  async validate(repo,commit,constraints,validityHeads={}){
    // These checks are platform code. No producer script or repository executable is run.
    const checks=[];const filename=repo.id==='checkout-api'?'checkout.json':'client.json';
    let config;try{config=JSON.parse(await this.file(repo,commit,filename));checks.push({name:'Configuration parses',passed:true,detail:'Trusted JSON parser accepted the exact candidate file.'});}catch{checks.push({name:'Configuration parses',passed:false,detail:'Candidate configuration is invalid JSON.'});return {passed:false,checks};}
    if(repo.id==='checkout-api'){
      checks.push({name:'Retry budget is bounded',passed:config.retry.maxAttempts>=1&&config.retry.maxAttempts<=5,detail:`maxAttempts=${config.retry.maxAttempts}; allowed range is 1–5.`});
      checks.push({name:'Currency contract is explicit',passed:['dollars','cents'].includes(config.accepts),detail:`API accepts ${config.accepts}. Cross-repository interactions need an explicit decision.`});
    }else{checks.push({name:'Currency unit is explicit',passed:['dollars','cents'].includes(config.sends),detail:`Client sends ${config.sends}.`});}
    if(repo.id==='storefront'&&validityHeads['checkout-api']){const contract=await this.interaction({id:'checkout-api'},validityHeads['checkout-api'],repo,commit);checks.push(...contract.checks);}
    return {passed:checks.every(c=>c.passed),checks,scope:[filename],limitations:['Finite structural checks do not establish global or production correctness.','No repository-supplied tests were executed.']};
  }
  async interaction(apiRepo,apiCommit,clientRepo,clientCommit){const api=JSON.parse(await this.file(apiRepo,apiCommit,'checkout.json'));const client=JSON.parse(await this.file(clientRepo,clientCommit,'client.json'));const wire=client.sends==='cents'?10*100:10;const charged=api.accepts==='dollars'?wire*100:wire;return {passed:charged===1000,checks:[{name:'$10 checkout preserves 1,000 cents',passed:charged===1000,detail:`Client sends ${wire} ${client.sends}; API interprets ${api.accepts}; charged amount = ${charged} cents.`}],scope:['checkout-api:checkout.json','storefront:client.json'],limitations:['One trusted contract scenario establishes only the demonstrated currency interaction.']};}
  async cas(repo,expected,commit){try{await git(this.dir(repo),['update-ref',repo.canonical_ref,commit,expected]);return true;}catch{return false;}}
  async diff(repo,base,head){return git(this.dir(repo),['diff','--no-ext-diff','--no-textconv',base,head]);}
  async externalAdvance(repo){const head=await this.ref(repo,repo.canonical_ref);const tree=await git(this.dir(repo),['rev-parse',`${head}^{tree}`]);const commit=await git(this.dir(repo),['commit-tree',tree,'-p',head,'-m','External Git client: canonical update']);await this.cas(repo,head,commit);return commit;}
}
