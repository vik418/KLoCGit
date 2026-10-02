import {DomainError,hash} from '../core/hash.mjs';
export class ArtifactsGit {
 constructor(env){this.env=env;this.configHash=env.VALIDATION_CONFIG_HASH??'unconfigured';}
 async withRepo(repo,fn){const capability=await this.env.ARTIFACTS.get(repo.id);try{return await fn(capability);}finally{capability[Symbol.dispose]?.();}}
 async ref(repo,ref){return this.withRepo(repo,async r=>{const log=await r.log({ref,limit:1});if(!log.length)throw new DomainError('REF_NOT_FOUND','Git ref does not exist',404);return log[0].hash;});}
 async flatten(r,tree,prefix='',budget={count:0}){if(++budget.count>20000)throw new DomainError('ANALYSIS_BUDGET','Tree traversal requires a larger asynchronous analysis budget',422);const output=Object.create(null);const entries=await r.readTree(tree);if(!entries)throw new DomainError('MISSING_TREE','Immutable Git tree is unavailable',404);for(const entry of entries){const file=prefix+entry.name;if(entry.type==='tree')Object.assign(output,await this.flatten(r,entry.hash,file+'/',budget));else output[file]={hash:entry.hash,mode:entry.mode};}return output;}
 async facts(repo,head,base){return this.withRepo(repo,async r=>{const [commit,baseline]=await Promise.all([r.readCommit(head),r.readCommit(base)]);if(!commit||!baseline)throw new DomainError('MISSING_COMMIT','Immutable Git commit is unavailable',404);const [a,b]=await Promise.all([this.flatten(r,commit.treeHash),this.flatten(r,baseline.treeHash)]);const scope=[...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>JSON.stringify(a[k])!==JSON.stringify(b[k])).sort();return {head:commit.hash,base:baseline.hash,tree:commit.treeHash,scope};});}
 async execute(operation,payload){
   if(!this.env.GIT_EXECUTOR||!this.env.GIT_BRIDGE_TOKEN||this.configHash==='unconfigured')throw new DomainError('GIT_EXECUTOR_UNAVAILABLE','A trusted Git executor and versioned validation configuration must be configured. Git ingestion remains available.',503);
   const response=await this.env.GIT_EXECUTOR.fetch(new Request('https://git-executor.internal/'+operation,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+this.env.GIT_BRIDGE_TOKEN},body:JSON.stringify({...payload,configHash:this.configHash})}));
   const data=await response.json();if(!response.ok)throw new DomainError(data.error??'GIT_EXECUTOR_FAILED',data.message??'Git executor failed',response.status);return data;
 }
 async compose(repo,head,revisions){return this.execute('compose',{repo:repo.id,head,revisions});}
 async validate(repo,commit,constraints,validityHeads){return this.execute('validate',{repo:repo.id,commit,constraints,validityHeads});}
 async cas(repo,expected,commit){const result=await this.execute('cas',{repo:repo.id,ref:repo.canonical_ref,expected,commit});return result.updated===true;}
 async diff(){throw new DomainError('DIFF_EXECUTOR_REQUIRED','Exact diffs require the Git executor',503);}
}
