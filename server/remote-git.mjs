import {mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {LocalGit,git} from './git.mjs';
import {DomainError} from '../core/hash.mjs';
const exec=promisify(execFile);
const commit=value=>{if(!/^[a-f0-9]{40}$/.test(value??''))throw new DomainError('INVALID_COMMIT','Full immutable Git commit hashes are required');return value;};

export class RemoteGit extends LocalGit {
  constructor(root,manifest){super(root);this.manifest=manifest;}
  entry(id){
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id??''))throw new DomainError('INVALID_REPO','Executor repository identifiers are bounded names');
    const entry=this.manifest.repositories?.[id];let remote;
    try{remote=new URL(entry?.remote);}catch{}
    if(!entry||remote?.protocol!=='https:'||remote.username||remote.password||!remote.hostname.endsWith('.artifacts.cloudflare.net')||!/^[A-Z][A-Z0-9_]*$/.test(entry.tokenEnv??'')||!process.env[entry.tokenEnv])throw new DomainError('REPO_NOT_CONFIGURED','Executor has no scoped Artifacts repository credential',503);
    return entry;
  }
  configured(repo){const entry=this.entry(repo.id);return {...repo,validation_profile:entry.validation_profile,context_repo:entry.context_repo??entry.dependencies?.[0]};}
  async remote(id,args){
    const entry=this.entry(id),env={...process.env,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_VALUE_0:'Authorization: Bearer '+process.env[entry.tokenEnv]};
    try{return (await exec('/usr/bin/git',args,{cwd:this.dir({id}),env,maxBuffer:4*1024*1024,timeout:60000})).stdout.trim();}
    catch{throw new DomainError('REMOTE_GIT_FAILED','Authenticated Git operation failed; credentials are excluded from diagnostics',503);}
  }
  async ensure(id){
    const entry=this.entry(id);await mkdir(this.dir({id}),{recursive:true});
    try{await git(this.dir({id}),['rev-parse','--is-bare-repository']);}catch{await git(this.dir({id}),['init','--bare','--quiet']);}
    await this.remote(id,['fetch','--quiet',entry.remote,'+refs/heads/*:refs/heads/*','+refs/converge/candidates/*:refs/converge/candidates/*']);
  }
  async ensureCommit(id,oid){commit(oid);await this.ensure(id);try{await git(this.dir({id}),['cat-file','-e',`${oid}^{commit}`]);}catch{await this.remote(id,['fetch','--quiet',this.entry(id).remote,oid]);}}
  async compose(repo,head,revisions){
    commit(head);await this.ensureCommit(repo.id,head);
    for(const revision of revisions){commit(revision.head_commit);commit(revision.base_commit);const source=revision.source_repo??repo.id;await this.ensureCommit(source,revision.head_commit);await this.ensureCommit(source,revision.base_commit);
      if(source!==repo.id)for(const oid of [revision.head_commit,revision.base_commit])await git(this.dir(repo),['fetch','--quiet',this.dir({id:source}),oid]);}
    const result=await super.compose(this.configured(repo),head,revisions);
    // Retain the actual candidate before the engine prepares a canonical operation.
    const ref=`refs/converge/candidates/${result.commit}`;
    await this.remote(repo.id,['push','--porcelain',this.entry(repo.id).remote,`${result.commit}:${ref}`]);
    const observed=await this.remote(repo.id,['ls-remote',this.entry(repo.id).remote,ref]);
    if(observed.split(/\s/)[0]!==result.commit)throw new DomainError('CANDIDATE_RETENTION_FAILED','The immutable candidate is not retained in authoritative Git',503);
    return {...result,retention_ref:ref};
  }
  async validate(repo,oid,constraints,validityHeads={}){
    await this.ensureCommit(repo.id,oid);for(const [id,head] of Object.entries(validityHeads))await this.ensureCommit(id,head);
    return super.validate(this.configured(repo),oid,constraints,validityHeads);
  }
  async message(repo,oid){await this.ensureCommit(repo.id,oid);return super.message(repo,oid);}
  async trailers(repo,oid){
    const message=await this.message(repo,oid),parsed=await git(this.dir(repo),['interpret-trailers','--parse'],message+'\n');
    return parsed.split('\n').filter(Boolean).map(line=>{const colon=line.indexOf(':');return {key:line.slice(0,colon).trim(),value:line.slice(colon+1).trim()};});
  }
  async diff(repo,base,head){await this.ensureCommit(repo.id,base);await this.ensureCommit(repo.id,head);return super.diff(repo,base,head);}
  async cas(repo,expected,target){
    commit(expected);commit(target);if(!/^refs\/heads\/[\w./-]+$/.test(repo.canonical_ref??'')||repo.canonical_ref.includes('..'))throw new DomainError('INVALID_REF','Invalid canonical ref');
    await this.ensureCommit(repo.id,target);const remote=this.entry(repo.id).remote;
    try{await this.remote(repo.id,['push','--porcelain',`--force-with-lease=${repo.canonical_ref}:${expected}`,remote,`${target}:${repo.canonical_ref}`]);return true;}
    catch(error){
      const refs=await this.remote(repo.id,['ls-remote',remote,repo.canonical_ref]),observed=refs.split(/\s/)[0];
      // Our exact target after transport failure is recovered from immutable intent.
      // Never classify it as a failed CAS or silently repeat the write.
      if(observed&&observed!==expected&&observed!==target)return false;
      throw error;
    }
  }
}
