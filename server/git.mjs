import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {hash,DomainError} from '../core/hash.mjs';
import {createApplicationRunner,applicationValidationConfigHash} from './runner.mjs';
const exec=promisify(execFile);
export async function git(cwd,args,input) {
  if(input!==undefined){return new Promise((resolve,reject)=>{const p=execFile('git',args,{cwd,env:{...process.env,GIT_AUTHOR_NAME:'Converge',GIT_AUTHOR_EMAIL:'platform@local',GIT_COMMITTER_NAME:'Converge',GIT_COMMITTER_EMAIL:'platform@local'},maxBuffer:4*1024*1024},(err,stdout)=>err?reject(err):resolve(stdout.trim()));p.stdin.end(input);});}
  return (await exec('git',args,{cwd,env:{...process.env,GIT_AUTHOR_NAME:'Converge',GIT_AUTHOR_EMAIL:'platform@local',GIT_COMMITTER_NAME:'Converge',GIT_COMMITTER_EMAIL:'platform@local'},maxBuffer:4*1024*1024})).stdout.trim();
}
export class LocalGit {
  constructor(root){this.root=root;this.configHash='';}
  async init(){this.configHash=await applicationValidationConfigHash();return this;}
  suitesForScope(repo,scope){return repo.validation_profile==='checkout-effects-v2'&&scope.some(p=>['client/retry.mjs','server/charge.mjs','app.mjs'].includes(p))?['checkout-effects']:[];}
  async message(repo,commit){return git(this.dir(repo),['show','-s','--format=%B',commit]);}
  async trailers(repo,commit){return git(this.dir(repo),['interpret-trailers','--parse'],await this.message(repo,commit));}
  dir(repo){return path.join(this.root,'repositories',repo.id+'.git');}
  async ref(repo,ref){if(!/^refs\/heads\/[a-zA-Z0-9._/-]+$/.test(ref)||ref.includes('..'))throw new DomainError('INVALID_REF','A valid branch ref is required');try{return await git(this.dir(repo),['rev-parse','--verify',ref]);}catch{throw new DomainError('REF_NOT_FOUND','Git ref is unavailable',404);}}
  async facts(repo,head,base){if(!/^[a-f0-9]{40}$/.test(head)||!/^[a-f0-9]{40}$/.test(base))throw new DomainError('INVALID_COMMIT','Full immutable commit hashes are required');const tree=await git(this.dir(repo),['rev-parse',`${head}^{tree}`]);const scope=(await git(this.dir(repo),['diff','--name-only',base,head])).split('\n').filter(Boolean);return {head,base,tree,scope};}
  async compose(repo,head,revisions){
    const temp=await mkdtemp(path.join(os.tmpdir(),'converge-'));const cwd=path.join(temp,'work');
    try{await git(temp,['clone','--quiet','--no-hardlinks',this.dir(repo),cwd]);await git(cwd,['checkout','--quiet','--detach',head]);
      for(const revision of revisions){await git(cwd,['fetch','--quiet','origin',revision.head_commit]);const patch=await git(cwd,['diff','--binary',revision.base_commit,revision.head_commit]);if(!patch)continue;try{await git(cwd,['apply','--3way','--index'],patch+'\n');}catch{throw new DomainError('COMPOSITION_CONFLICT','The candidate has a textual conflict and requires conventional review',422);}}
      const trailers=[...new Set(revisions.flatMap(r=>[`Proposal-Revision: ${r.id}`,...(r.context_task_id?[`Decision-Task: ${r.context_task_id}`,`Decision-Context: ${r.context_version}`]:[]),...(r.context_answer_ref?[`Decision-Answer: ${r.context_answer_ref}`]:[])]))].sort();
      const tree=await git(cwd,['write-tree']);const baseTree=await git(cwd,['rev-parse',`${head}^{tree}`]);const commit=await git(cwd,['commit-tree',tree,'-p',head],['Converge: immutable reviewed candidate','',...trailers,''].join('\n'));await git(this.dir(repo),['fetch','--quiet',cwd,commit]);await git(this.dir(repo),['update-ref',`refs/converge/candidates/${commit}`,commit]);return {tree,commit,baseTree};
    }finally{await rm(temp,{recursive:true,force:true});}
  }
  async file(repo,commit,name){try{return await git(this.dir(repo),['show',`${commit}:${name}`]);}catch{return null;}}
  async validate(repo,commit,constraints,validityHeads={}){
    if(repo.validation_profile==='checkout-effects-v2'){
      const policyRepo=repo.context_repo??'payment-policy';const policyCommit=validityHeads[policyRepo];
      const runner=await createApplicationRunner({repositoryPath:this.dir(repo),policyRepositoryPath:policyCommit?this.dir({id:policyRepo}):null,policyCommit});return runner.validate(commit);
    }
    if(repo.validation_profile==='context-document-v1'){
      let value;try{value=JSON.parse(await this.file(repo,commit,'checkout-policy.json'));}catch{return {passed:false,checks:[{name:'Policy document parses',passed:false,detail:'The immutable policy is not valid JSON.'}],limitations:['No code execution or general correctness claim.']};}
      const passed=value.maxChargesPerOrder===1&&value.maxConfirmationsPerOrder===1&&Array.isArray(value.allowed_values);return {passed,checks:[{name:'Versioned exactly-once policy is supported',passed,detail:'A supported immutable policy bounds charges and confirmations at one.'}],limitations:['Only this versioned policy schema is checked.']};
    }
    return {passed:false,status:'validation-unavailable',checks:[{name:'Trusted validation profile is configured',passed:false,detail:'Unknown code remains conventional review; no safe-convergence claim is made.'}],limitations:['No trusted profile exists for this repository.']};
  }
  async cas(repo,expected,commit){try{await git(this.dir(repo),['update-ref',repo.canonical_ref,commit,expected]);return true;}catch{return false;}}
  async diff(repo,base,head){return git(this.dir(repo),['diff','--no-ext-diff','--no-textconv',base,head]);}
  async externalAdvance(repo){const head=await this.ref(repo,repo.canonical_ref);const tree=await git(this.dir(repo),['rev-parse',`${head}^{tree}`]);const commit=await git(this.dir(repo),['commit-tree',tree,'-p',head,'-m','External Git client: canonical update']);await this.cas(repo,head,commit);return commit;}
}
