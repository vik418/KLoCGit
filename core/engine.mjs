import {hash, record, DomainError} from './hash.mjs';
import {deriveDecisionComponents} from './components.mjs';
import {prepareTaskContext,answerTaskContext,assumeTaskContext} from './context.mjs';
const now = () => new Date().toISOString();
export function emptyState() {return {version:2,tasks:[],contextPreparations:[],dispositions:[],discovery:{ungrouped_revision_ids:[],conventional_review_ids:[],diagnostics:[]},analysisCache:{},workspace:{id:'northstar',name:'Northstar',description:'Checkout reliability',mode:'local-demo',producers:[]},repositories:[],forks:[],implementations:[],operations:[],intents:[],contexts:[],proposals:[],revisions:[],relationships:[],constraints:[],evidence:[],compositions:[],decisionComponents:[],decisions:[],audit:[],events:{},refVersions:{},metrics:{comparisons:0,possibleComparisons:0,casFailures:0,staleEvidenceAccepted:0,duplicateClassifications:0,automaticReversals:0},analysis:{status:'deterministic',analyzer:'git-tree-v1',semantic:'unavailable'}};}
export class Engine {
  constructor(state,git,save=async()=>{}) {state.tasks??=[];state.contextPreparations??=[];state.dispositions??=[];state.analysisCache??={};state.discovery??={ungrouped_revision_ids:[],conventional_review_ids:[],diagnostics:[]};state.forks??=[];state.operations??=[];state.implementations??=[];this.state=state;this.git=git;this.save=save;this._tail=Promise.resolve();}
  serial(fn) {const pending=this._tail.then(fn);this._tail=pending.catch(()=>{});return pending;}
  async audit(type,actor,data) {const previous=this.state.audit.at(-1)?.id??null;this.state.audit.push(await record('audit',{type,actor,data,previous,created_at:now()}));}
  repo(id) {const r=this.state.repositories.find(r=>r.id===id);if(!r)throw new DomainError('REPO_NOT_FOUND','Repository not found',404);return r;}
  revision(id) {const r=this.state.revisions.find(r=>r.id===id);if(!r)throw new DomainError('REVISION_NOT_FOUND','Revision not found',404);return r;}
  component(id) {const c=this.state.decisionComponents.find(c=>c.id===id);if(!c)throw new DomainError('DECISION_NOT_FOUND','Decision not found',404);return c;}
  async ingest(event, metadata={}) {
    if(!event.repo||!event.ref||!event.after)throw new DomainError('INVALID_EVENT','Repository, ref and immutable head are required');
    const repo=this.repo(event.repo);
    if(event.source_repo&&event.source_repo!==repo.id&&!this.state.forks.some(f=>f.id===event.source_repo&&f.repo===repo.id))throw new DomainError('UNREGISTERED_FORK','Producer repository is not registered for this canonical repository',403);
    const sourceRepo=event.source_repo?{...repo,id:event.source_repo}:repo;
    if(sourceRepo.id===repo.id&&event.ref===repo.canonical_ref){await this.syncHeads();return {canonical:true,head:repo.head};}
    const eventId=await hash({repo:event.repo,source_repo:sourceRepo.id,ref:event.ref,before:event.before??null,after:event.after});
    if(this.state.events[eventId]){const head=await this.git.ref(sourceRepo,event.ref);if(head===event.after)this.state.refVersions[`${sourceRepo.id}:${event.ref}`]=head;await this.save(this.state);return {duplicate:true,revision_id:this.state.events[eventId]};}
    // Ref freshness comes from authoritative Git. Timestamps are never used as version counters.
    const authoritative=await this.git.ref(sourceRepo,event.ref);
    if(authoritative!==event.after)return {ignored:true,reason:'OUT_OF_ORDER_EVENT',head:authoritative};
    const facts=await this.git.facts(sourceRepo,event.after,repo.baseline);
    const declared=await this.readDeclaration(sourceRepo,event.after);
    const safeMeta={title:String(metadata.title??declared.title??event.ref.split('/').at(-1)).slice(0,200),statement:String(metadata.statement??declared.statement??'Intent not supplied').slice(0,1000),producer:String(metadata.producer??declared.producer??'Git client').slice(0,100),provenance_state:metadata.provenance_state==='declared'||declared.present?'declared':'unknown'};
    const proposalId=await hash({repo:repo.id,source_repo:sourceRepo.id,ref:event.ref});
    let proposal=this.state.proposals.find(p=>p.id===proposalId);
    if(!this.state.workspace.producers.includes(safeMeta.producer))this.state.workspace.producers.push(safeMeta.producer);
    if(!proposal){const intent=await record('intent',{statement:safeMeta.statement,scope:facts.scope,source:safeMeta.producer,basis:safeMeta.provenance_state==='unknown'?'inferred':'declared',created_at:now()});this.state.intents.push(intent);proposal={intent_id:intent.id,id:proposalId,repo:repo.id,source_repo:sourceRepo.id,ref:event.ref,...safeMeta,created_at:now()};this.state.proposals.push(proposal);}
    let context=await record('ctx',{items:[{type:'intent',value:safeMeta.statement,basis:safeMeta.provenance_state==='unknown'?'inferred':'declared',source:safeMeta.producer,validity_scope:facts.scope}],constraints:this.state.constraints.map(c=>c.id),canonical_heads:this.state.repositories.map(r=>({repo:r.id,head:r.head}))});
    const binding=await this.bindContext(sourceRepo,event.after,repo.id);
    if(binding.snapshot)context=binding.snapshot;
    if(!this.state.contexts.some(c=>c.id===context.id))this.state.contexts.push(context);
    const implementation=await record('impl',{repo:repo.id,tree_hash:facts.tree});if(!this.state.implementations.some(i=>i.id===implementation.id))this.state.implementations.push(implementation);
    const revision=await record('rev',{proposal_id:proposalId,implementation_ref:implementation.id,repo:repo.id,source_repo:sourceRepo.id,base_commit:facts.base,head_commit:facts.head,tree_hash:facts.tree,context_version:context.id,affected_scope:facts.scope,symbol_footprint:facts.symbols??[],provenance_state:safeMeta.provenance_state,decision_key:declared.decision_key??null,declared_choice:declared.choice??null,context_binding_state:binding.state,context_task_id:binding.task_id??null,context_answer_ref:binding.snapshot?.answer_ref??null,context_binding_reason:binding.reason??null});
    if(!this.state.revisions.some(r=>r.id===revision.id))this.state.revisions.push(revision);
    this.state.events[eventId]=revision.id;this.state.refVersions[`${sourceRepo.id}:${event.ref}`]=facts.head;
    const others=this.state.revisions.filter(r=>r.repo===repo.id&&r.id!==revision.id);
    this.state.metrics.possibleComparisons+=others.length;
    for(const other of others.filter(r=>r.affected_scope.some(p=>facts.scope.includes(p))||r.tree_hash===facts.tree||(r.decision_key&&r.decision_key===revision.decision_key))) {
      this.state.metrics.comparisons++;
      const identical=other.tree_hash===facts.tree;
      const alternative=!!revision.decision_key&&revision.decision_key===other.decision_key&&revision.declared_choice!==other.declared_choice;
      const rel=await record('rel',{from_revision:other.id,to_revision:revision.id,type:identical?'implementation_equivalent':alternative?'alternative':'unknown',confidence:identical?1:null,basis:alternative?'declared':'observed',analyzer_version:alternative?'declared-choice-v1':'git-tree-v1',evidence_refs:[],observation:identical?'Identical complete Git tree; proposal histories remain separate.':alternative?`Producer declarations identify mutually exclusive choices for ${revision.decision_key}; no preference is inferred.`:'Affected paths overlap; no semantic conclusion.'});
      if(!this.state.relationships.some(r=>r.id===rel.id)){this.state.relationships.push(rel);if(identical)this.state.metrics.duplicateClassifications++;}
    }
    await this.audit('proposal.ingested','git-ingress',{revision_id:revision.id,event_id:eventId});await this.save(this.state);
    return {revision_id:revision.id,duplicate:false};
  }
  activeRevisions() {return this.state.revisions.filter(r=>this.state.refVersions[`${r.source_repo??r.repo}:${this.state.proposals.find(p=>p.id===r.proposal_id)?.ref}`]===r.head_commit);}
  evidenceValidity(e) {
    const reasons=[];
    for(const [repo,head] of Object.entries(e.validity_heads??{}))if(this.repo(repo).head!==head)reasons.push('canonical head changed');
    const currentConstraints=this.state.constraints.filter(c=>c.active).map(c=>c.id).sort();
    if(JSON.stringify([...(e.constraint_versions??[])].sort())!==JSON.stringify(currentConstraints))reasons.push('constraint version changed');
    if(e.config_hash!==this.git.configHash)reasons.push('validation configuration changed');
    return {status:reasons.length?'stale':'current',reasons};
  }
  async syncHeads() {
    let changed=false;
    for(const repo of this.state.repositories){const head=await this.git.ref(repo,repo.canonical_ref);if(head!==repo.head){const previous=repo.head;repo.head=head;changed=true;await this.audit('canonical.observed','git',{repo:repo.id,previous,head});}}
    if(changed)await this.save(this.state);return changed;
  }
  async validate(subject,repo,tree,commit,validityHeads={}) {
    const configHash=this.git.configHash;const constraints=this.state.constraints.filter(c=>c.active);const constraintVersions=constraints.map(c=>c.id);
    const result=await this.git.validate(repo,commit,constraints.filter(c=>c.kind==='checkable'),validityHeads);
    const evidence=await record('ev',{subject_ref:subject,tree_hash:tree,type:'trusted-validation',config_hash:configHash,result,source:'platform-owned checks',created_at:now(),validity_heads:validityHeads,constraint_versions:constraintVersions,claim:'Establishes only the listed checks for this exact tree and configuration.'});
    this.state.evidence.push(evidence);return evidence;
  }
  async contextValidity(snapshot) {
    for(const source of snapshot?.sources??[]){const repo=this.repo(source.repo),head=await this.git.ref(repo,source.ref_seen??repo.canonical_ref);const content=await this.git.file(repo,head,source.path);if(typeof content!=='string'||await hash(content)!==source.content_hash)return {status:'stale',reason:'Retrieved policy content changed; prepare and review a new context.'};}
    return {status:'current'};
  }
  async compose(repoId,revisionIds) {
    const repo=this.repo(repoId);const revisions=revisionIds.map(id=>this.revision(id));
    if(revisions.some(r=>r.repo!==repoId))throw new DomainError('CROSS_REPO_COMPOSITION','A Git composition belongs to one repository');
    const baseHead=repo.head;const validityHeads=Object.fromEntries(this.state.repositories.map(r=>[r.id,r.head]));
    const unique=[...new Map(revisions.map(r=>[r.tree_hash,r])).values()];
    const result=await this.git.compose(repo,baseHead,unique);
    if(result.conflict)throw new DomainError('COMPOSITION_CONFLICT','Candidate cannot be applied because the Git merge failed',422);
    const composition=await record('comp',{repo:repoId,proposal_revision_ids:[...revisionIds].sort(),base_commit:baseHead,base_tree:result.baseTree,resulting_tree:result.tree,commit:result.commit});
    if(!this.state.compositions.some(c=>c.id===composition.id))this.state.compositions.push(composition);
    let evidence=await this.validate(composition.id,repo,result.tree,result.commit,validityHeads);
    const contextChecks=[];
    for(const r of revisions.filter(r=>r.context_binding_state==='bound'||r.context_binding_state==='invalid')){
      const snapshot=this.state.contexts.find(c=>c.id===r.context_version),validity=await this.contextValidity(snapshot);
      const expected=snapshot?.parameter_values?.retry_failed_response,observed=evidence.result.observations?.lostResponse?.attempts;
      const passed=r.context_binding_state==='bound'&&validity.status==='current'&&typeof expected==='boolean'&&observed===(expected?2:1);
      contextChecks.push({name:'Bound retry answer matches observed behavior',passed,detail:validity.status==='stale'?validity.reason:`Immutable answer expects ${expected?2:1} attempt(s); trusted transport observed ${observed??'unavailable'}.`});
    }
    if(contextChecks.length){evidence=await record('ev',{...Object.fromEntries(Object.entries(evidence).filter(([k])=>k!=='id')),result:{...evidence.result,passed:evidence.result.passed&&contextChecks.every(c=>c.passed),checks:[...evidence.result.checks,...contextChecks]},created_at:now()});this.state.evidence.push(evidence);}
    return {composition_id:composition.id,evidence_ids:[evidence.id],validation:result.conflict?'conflict':evidence.result.passed?'passed':'failed'};
  }
  async readDeclaration(repo,head) {
    if(!this.git.file)return {};
    const raw=await this.git.file(repo,head,'.converge/proposal.json');if(!raw||raw.length>32768)return {};
    try{const d=JSON.parse(raw);return {present:true,title:typeof d.title==='string'?d.title.slice(0,200):undefined,statement:typeof d.statement==='string'?d.statement.slice(0,1000):undefined,producer:typeof d.producer==='string'?d.producer.slice(0,100):undefined,decision_key:typeof d.decision_key==='string'?d.decision_key.slice(0,100):null,choice:typeof d.choice==='string'?d.choice.slice(0,100):null};}catch{return {};}
  }
  async bindContext(repo,head,targetRepo=repo.id) {
    if(!this.git.file)return {state:'unknown'};
    const raw=await this.git.file(repo,head,'.converge/context.json');if(!raw)return {state:'unknown'};
    try{const artifact=JSON.parse(raw);const task=this.state.tasks.find(t=>t.task.id===artifact.task_id);
      if(!task?.authorization||!task.snapshot)return {state:'invalid',task_id:artifact.task_id,reason:'Task has no answered or explicitly assumed authorization.'};
      if(task.task.target_repo!==targetRepo)return {state:'invalid',task_id:artifact.task_id,reason:'The task targets another canonical repository.'};
      if((artifact.context_snapshot_id??artifact.context_version)!==task.snapshot.id||artifact.authorization_ref!==task.authorization.id||artifact.answer_ref!==task.snapshot.answer_ref)return {state:'invalid',task_id:artifact.task_id,reason:'Code context identifiers differ from the immutable authorization.'};
      const parsed=this.git.trailers?await this.git.trailers(repo,head):'';const trailers=Array.isArray(parsed)?parsed.map(t=>`${t.key}: ${t.value}`):parsed.split('\n');
      const required=[`Decision-Task: ${task.task.id}`,`Decision-Context: ${task.snapshot.id}`,`Decision-Authorization: ${task.authorization.id}`,...(task.snapshot.answer_ref?[`Decision-Answer: ${task.snapshot.answer_ref}`]:[])];
      if(required.some(t=>!trailers.includes(t)))return {state:'invalid',task_id:task.task.id,reason:'The commit does not carry the exact trailing authorization references.'};
      if((await this.contextValidity(task.snapshot)).status!=='current')return {state:'invalid',task_id:task.task.id,reason:'The retrieved policy content has changed.'};
      return {state:'bound',task_id:task.task.id,snapshot:task.snapshot};
    }catch{return {state:'invalid',reason:'Context artifact cannot be verified.'};}
  }
  async prepareTask(input,actor) {
    const task=await prepareTaskContext({task:input,repositories:this.state.repositories,git:this.git,actor});this.state.tasks.push(task);this.state.contextPreparations.push(task);if(task.snapshot)this.state.contexts.push(task.snapshot);
    for(const c of this.state.constraints){const prior=this.state.contextPreparations.find(p=>p.source.id===c.source_ref);if(prior&&prior.source.repo===task.source.repo&&prior.source.path===task.source.path&&c.id!==task.constraint.id)c.active=false;}
    if(!this.state.constraints.some(c=>c.id===task.constraint.id))this.state.constraints.push({...task.constraint.value,id:task.constraint.id,source_ref:task.source.id,active:true});
    await this.audit('context.prepared',actor,{task_id:task.task.id,question_id:task.question?.id??null,source:task.source.id});await this.save(this.state);return task;
  }
  async resolveTask(id,input,actor,assumption=false) {
    const i=this.state.tasks.findIndex(t=>t.task.id===id);if(i<0)throw new DomainError('TASK_NOT_FOUND','Task not found',404);
    const prior=this.state.tasks[i];if((await this.contextValidity({sources:[prior.source]})).status!=='current')throw new DomainError('CONTEXT_STALE','The retrieved policy changed. Prepare a new task before answering.',409);
    if(prior.authorization){const item=prior.snapshot.items.find(i=>i.type===(assumption?'assumption':'parameter'));if(item?.source?.actor===actor&&prior.snapshot.parameter_values.retry_failed_response===input.value&&(!assumption||item.value.rationale===input.rationale))return prior;throw new DomainError('CONTEXT_ALREADY_RESOLVED','This task has a different immutable answer or assumption.',409);}
    const task=await (assumption?assumeTaskContext:answerTaskContext)(prior,{value:input.value,rationale:input.rationale,actor,created_at:now()});this.state.tasks[i]=task;this.state.contextPreparations.push(task);this.state.contexts.push(task.snapshot);
    await this.audit(assumption?'context.assumed':'context.answered',actor,{task_id:id,context_version:task.snapshot.id,answer_ref:task.snapshot.answer_ref,source:task.source.id});await this.save(this.state);return task;
  }
  settled(id) {return this.state.dispositions.some(d=>d.revision_id===id);}
  currentEvidence(subject) {return this.state.evidence.filter(e=>e.subject_ref===subject&&e.source==='platform-owned checks'&&this.evidenceValidity(e).status==='current').at(-1);}
  applicableRelationships() {
    const latest=new Map();for(const r of this.state.relationships)if(r.version_key)latest.set(r.version_key,r.id);
    return this.state.relationships.filter(r=>!r.version_key||latest.get(r.version_key)===r.id);
  }
  async analyzeWork({actor='coordinator',refresh=false}={}) {
    await this.syncHeads();const start=performance.now();const active=this.activeRevisions().filter(r=>!this.settled(r.id)).sort((a,b)=>a.id.localeCompare(b.id));
    const validityHeads=Object.fromEntries(this.state.repositories.map(r=>[r.id,r.head]));const baselines=new Map();
    for(const repo of this.state.repositories.filter(repo=>active.some(r=>r.repo===repo.id))){const subject='baseline:'+repo.id+':'+repo.head;let e=this.currentEvidence(subject);if(!e){const facts=await this.git.facts(repo,repo.head,repo.head);e=await this.validate(subject,repo,facts.tree,repo.head,validityHeads);}baselines.set(repo.id,e);}
    // Singles and pairs are rebased/composed onto the same captured canonical heads.
    for(const r of active){if(this.currentEvidence(r.id))continue;
      try{const candidate=await this.compose(r.repo,[r.id]),e=this.state.evidence.find(e=>e.id===candidate.evidence_ids[0]);const single=await record('ev',{...Object.fromEntries(Object.entries(e).filter(([k])=>k!=='id')),subject_ref:r.id,composition_ref:candidate.composition_id,subject_versions:[{revision_id:r.id,head_commit:r.head_commit,tree_hash:r.tree_hash}],created_at:now()});this.state.evidence.push(single);}
      catch(e){if(e.code!=='COMPOSITION_CONFLICT')throw e;const failure=await record('ev',{subject_ref:r.id,tree_hash:r.tree_hash,type:'git-composition',config_hash:this.git.configHash,result:{passed:false,checks:[{name:'Apply to current canonical base',passed:false,detail:e.message}]},source:'platform-owned checks',created_at:now(),validity_heads:validityHeads,constraint_versions:this.state.constraints.filter(c=>c.active).map(c=>c.id),claim:'Git application failed on the captured base; this is not a semantic correctness claim.'});this.state.evidence.push(failure);}
    }
    const unique=[...new Map(active.map(r=>[`${r.repo}:${r.tree_hash}`,r])).values()].sort((a,b)=>a.id.localeCompare(b.id));
    for(let i=0;i<unique.length;i++)for(let j=i+1;j<unique.length;j++){
      const a=unique[i],b=unique[j];if(a.repo!==b.repo)continue;
      if(this.applicableRelationships().some(r=>r.type==='alternative'&&[r.from_revision,r.to_revision].includes(a.id)&&[r.from_revision,r.to_revision].includes(b.id)))continue;
      const footprintA=this.git.suitesForScope?.(this.repo(a.repo),a.affected_scope)??[],footprintB=this.git.suitesForScope?.(this.repo(b.repo),b.affected_scope)??[];
      const overlaps=a.affected_scope.some(path=>b.affected_scope.includes(path));if(!overlaps&&!footprintA.some(suite=>footprintB.includes(suite)))continue;
      if(!baselines.get(a.repo)?.result.passed||!this.currentEvidence(a.id)?.result.passed||!this.currentEvidence(b.id)?.result.passed)continue;
      const versions=[a.id,b.id].sort(),key=await hash({versions,heads:validityHeads,constraints:this.state.constraints.filter(c=>c.active).map(c=>c.id).sort(),config:this.git.configHash});if(this.state.analysisCache[key])continue;
      this.state.metrics.interactionComparisons=(this.state.metrics.interactionComparisons??0)+1;
      let composed,evidence,textual=false;
      try{composed=await this.compose(a.repo,versions);evidence=this.state.evidence.find(e=>e.id===composed.evidence_ids[0]);}
      catch(e){if(e.code!=='COMPOSITION_CONFLICT')throw e;textual=true;evidence={tree_hash:null,result:{passed:false,checks:[{name:'Git composition',passed:false,detail:e.message}]},config_hash:this.git.configHash,constraint_versions:this.state.constraints.filter(c=>c.active).map(c=>c.id)};}
      this.state.analysisCache[key]={composition_id:composed?.composition_id??null,textual_conflict:textual,evidence_id:evidence.id??null};
      if(!evidence.result.passed){
        const proof=await record('ev',{subject_ref:versions,subject_revision_ids:versions,subject_versions:[a,b].map(r=>({revision_id:r.id,head_commit:r.head_commit,tree_hash:r.tree_hash})).sort((x,y)=>x.revision_id.localeCompare(y.revision_id)),composition_ref:composed?.composition_id??null,tree_hash:evidence.tree_hash,type:textual?'textual-composition-conflict':'composed-interaction',config_hash:evidence.config_hash,result:evidence.result,source:'platform-owned interaction checks',created_at:now(),validity_heads:validityHeads,constraint_versions:evidence.constraint_versions,baseline_evidence_id:baselines.get(a.repo).id,individual_evidence_ids:[this.currentEvidence(a.id).id,this.currentEvidence(b.id).id],claim:textual?'Each singleton applies and passes on the same base; their Git composition fails.': 'Baseline and each singleton passed on the same captured canonical base; this exact textually merged pair failed the listed trusted check.'});
        this.state.evidence.push(proof);const rel=await record('rel',{from_revision:versions[0],to_revision:versions[1],type:'conflicts_with',version_key:await hash({versions,analyzer:'trusted-pair-v2'}),confidence:1,basis:'observed',analyzer_version:'trusted-pair-v2',evidence_refs:[proof.id],observation:proof.result.checks.filter(c=>!c.passed).map(c=>c.detail).join(' ')});this.state.relationships.push(rel);
      }
    }
    const result=await deriveDecisionComponents({...this.state,relationships:this.applicableRelationships()},{activeRevisions:active,evidenceValidity:e=>this.evidenceValidity(e)});this.state.decisionComponents=[...result.components,...result.historical_components];
    const safeIndependent=result.ungrouped_revision_ids.filter(id=>{const r=this.revision(id);return this.currentEvidence(id)?.result.passed&&r.context_binding_state!=='invalid'&&(r.provenance_state!=='unknown'||r.affected_scope.every(path=>/\.md$/i.test(path)));});
    // An unattached change still needs an explicit human review, even if checks pass.
    const attached=safeIndependent.filter(id=>result.components.some(c=>c.status==='open'&&c.scope.includes(this.revision(id).repo)));
    this.state.discovery={...result,components:undefined,historical_components:undefined,supplemental_revision_ids:attached,conventional_review_ids:result.ungrouped_revision_ids.filter(id=>!attached.includes(id)),explanation:'Only unresolved alternative/conflict edges connect decision groups. Independent work remains separate and can be included in an explicitly reviewed, validated composition. Unattached and unknown executable work remain conventional review.'};
    for(const c of this.state.decisionComponents.filter(c=>c.status==='open')){
      c.supplemental_revision_ids=attached.filter(id=>c.scope.includes(this.revision(id).repo));c.included=c.supplemental_revision_ids.map(id=>{const r=this.revision(id),p=this.state.proposals.find(p=>p.id===r.proposal_id);return `${p.title} · independent of the decision graph · ${r.provenance_state==='unknown'?'unknown provenance; explicit review':'declared intent'}`;});
      const snapshots=[...c.revision_ids,...(c.supplemental_revision_ids??[])].map(id=>this.state.contexts.find(ctx=>ctx.id===this.revision(id).context_version)).filter(Boolean);c.assumptions=snapshots.flatMap(ctx=>ctx.items??[]).filter(i=>i.type==='assumption').map(i=>({id:i.id,value:i.value.rationale,basis:i.basis,source:i.source,unresolved:true}));
      if(refresh||!c.basis_hash||c.basis_hash!==await this.basis(c))await this.buildDecision(c);
    }
    this.state.metrics.analysisLatencyMs=Math.round(performance.now()-start);await this.audit('analysis.completed',actor,{active_revisions:active.length,derived_components:result.components.length,independent_revisions:result.ungrouped_revision_ids,conventional_review_ids:this.state.discovery.conventional_review_ids});await this.save(this.state);return this.view();
  }
  async basis(component) {
    const ids=[...component.revision_ids,...(component.supplemental_revision_ids??[])];const relationships=this.applicableRelationships().filter(r=>ids.includes(r.from_revision)||ids.includes(r.to_revision));
    const alternatives=component.alternatives.map(a=>({...a,evidence:(a.evidence_ids??[]).map(id=>{const e=this.state.evidence.find(e=>e.id===id);return {id,validity:e?this.evidenceValidity(e):{status:'missing'}};})}));
    return hash({component_id:component.id,graph_hash:component.graph_hash,membership:this.activeRevisions().filter(r=>component.scope.includes(r.repo)).map(r=>r.id).sort(),revisions:ids.sort(),relationships:relationships.map(r=>r.id).sort(),constraints:this.state.constraints.filter(c=>c.active).map(c=>c.id).sort(),alternatives,heads:this.state.repositories.map(r=>({repo:r.id,head:r.head})).sort((a,b)=>a.repo.localeCompare(b.repo)),assumptions:component.assumptions??[],contexts:ids.map(id=>this.revision(id).context_version).sort()});
  }
  async buildDecision(c) {
    for(const a of c.alternatives){if(!a.repo){a.validation='cross-repo-review';continue;}const revisionIds=[...new Set([...a.revision_ids,...(c.supplemental_revision_ids??[]).filter(id=>this.revision(id).repo===a.repo)])];a.composed_revision_ids=revisionIds;
      try{Object.assign(a,await this.compose(a.repo,revisionIds));}catch(e){if(e.code!=='COMPOSITION_CONFLICT')throw e;a.validation='conflict';a.evidence_ids=[];a.error=e.message;}}
    c.basis_hash=await this.basis(c);c.canonical_head_seen=c.alternatives[0]?.repo?this.repo(c.alternatives[0].repo).head:null;
  }
  async refreshDecision(id) {
    const old=this.component(id);if(['resolved','deferred'].includes(old.status))return old;await this.analyzeWork({refresh:true});const current=this.state.decisionComponents.find(c=>c.id===id);if(!current)throw new DomainError('DECISION_STALE','The decision graph changed. Review the newly derived components.',409);return current;
  }
  async resolve(id,input,actor) {
    if(!actor)throw new DomainError('UNAUTHENTICATED','Authenticated actor required',401);
    if(this.state.operations.some(d=>['prepared','recovery-required'].includes(d.status)))throw new DomainError('RECOVERY_REQUIRED','A prior Git operation must be reconciled before advancing canonical state',409);
    const c=this.component(id);await this.syncHeads();
    const currentBasis=await this.basis(c);
    const option=c.alternatives.find(a=>a.id===input.alternative_id);if(!option)throw new DomainError('INVALID_RESOLUTION','Select a listed alternative');
    if(!option.repo)throw new DomainError('MANUAL_REVIEW_REQUIRED','Cross-repository or bounded review requires a conventional resolution.',422);const repo=this.repo(option.repo);
    if(['resolved','deferred'].includes(c.status))throw new DomainError('DECISION_RESOLVED','This decision is already resolved',409);
    if(input.basis_hash!==c.basis_hash||input.basis_hash!==currentBasis||input.expected_canonical_head!==repo.head){this.state.metrics.casFailures++;await this.audit('decision.stale-rejected',actor,{decision_id:id});await this.save(this.state);throw new DomainError('DECISION_STALE','The canonical head or reviewed decision basis changed. Review fresh evidence before applying.',409,{current_basis_hash:currentBasis,canonical_head:repo.head});}
    const composition=this.state.compositions.find(x=>x.id===option.composition_id);
    if(option.validation!=='passed'||!composition||composition.base_commit!==repo.head)throw new DomainError('DECISION_STALE','Composition requires rebuilding against canonical head',409);
    const checks=option.evidence_ids.map(x=>this.state.evidence.find(e=>e.id===x));
    if(!checks.length||checks.some(e=>!e||this.evidenceValidity(e).status!=='current'||!e.result.passed||e.tree_hash!==composition.resulting_tree||e.subject_ref!==composition.id||e.type!=='trusted-validation'||e.source!=='platform-owned checks'))throw new DomainError('VALIDATION_REQUIRED','Fresh passing validation of the composed tree is required',422);
    const expectedHead=repo.head;
    const resolution=await record('decision',{component_id:id,proposal_revision_ids:composition.proposal_revision_ids,decision_basis_hash:currentBasis,canonical_head_seen:repo.head,resolution:option.id,rationale:String(input.rationale??'').slice(0,2000),actor,reviewed_context_refs:[...new Set(c.revision_ids.map(id=>this.revision(id).context_version))],reviewed_context_answer_refs:[...new Set(c.revision_ids.map(id=>this.revision(id).context_answer_ref).filter(Boolean))],context_refs:composition.proposal_revision_ids.map(id=>this.revision(id).context_version),context_answer_refs:composition.proposal_revision_ids.map(id=>this.revision(id).context_answer_ref).filter(Boolean),deferred_revision_ids:option.deferred_revision_ids??[],created_at:now()});
    // Persist write-ahead intent before the external Git CAS. Recovery reconciles only this exact commit.
    this.state.decisions.push(resolution);const operation={id:'operation_'+resolution.id,decision_id:resolution.id,status:'prepared',target_commit:composition.commit,expected_head:expectedHead,repo:repo.id};this.state.operations.push(operation);await this.audit('canonical.prepared',actor,{decision_id:resolution.id,expected:repo.head,target:composition.commit});await this.save(this.state);
    let updated;try{updated=await this.git.cas(repo,expectedHead,composition.commit);}catch{operation.status='recovery-required';await this.audit('canonical.recovery-required',actor,{decision_id:resolution.id});await this.save(this.state);throw new DomainError('RECOVERY_REQUIRED','Git outcome is uncertain. Reconcile the prepared operation before another canonical update.',503);}
    if(!updated){operation.status='cas-failed';this.state.metrics.casFailures++;await this.audit('canonical.cas-failed',actor,{decision_id:resolution.id});await this.save(this.state);throw new DomainError('DECISION_STALE','Git compare-and-set rejected canonical advancement',409);}
    await this.restoreDispositions(resolution,composition.commit);
    repo.head=composition.commit;c.status='resolved';c.selected=option.id;c.resolution_id=resolution.id;operation.status='applied';
    await this.audit('canonical.updated',actor,{repo:repo.id,head:repo.head,decision_id:resolution.id,tree:composition.resulting_tree});await this.save(this.state);
    return {decision_id:resolution.id,canonical_head:repo.head,resolution:option.id};
  }
  async restoreDispositions(decision,commit) {
    for(const [status,ids] of [['applied',decision.proposal_revision_ids],['deferred',decision.deferred_revision_ids??[]]])for(const id of ids){if(this.state.dispositions.some(d=>d.revision_id===id&&d.decision_id===decision.id&&d.status===status))continue;this.state.dispositions.push(await record('disposition',{revision_id:id,status,decision_id:decision.id,...(status==='applied'?{commit}:{})}));}
  }
  async recover() {
    for(const operation of this.state.operations.filter(d=>['prepared','recovery-required'].includes(d.status))){
      const decision=this.state.decisions.find(d=>d.id===operation.decision_id);if(!decision)throw new DomainError('RECOVERY_REQUIRED','Prepared operation has no immutable decision',503);
      const repo=this.repo(operation.repo);const observed=await this.git.ref(repo,repo.canonical_ref);
      if(observed===operation.target_commit){await this.restoreDispositions(decision,operation.target_commit);operation.status='applied';repo.head=observed;const c=this.component(decision.component_id);c.status='resolved';c.selected=decision.resolution;c.resolution_id=decision.id;await this.audit('canonical.recovered','coordinator',{decision_id:decision.id,head:observed});}
      else {operation.status='recovery-required';await this.audit('canonical.recovery-required','coordinator',{decision_id:decision.id,observed});}
    }await this.save(this.state);
  }
  async view() {
    await this.syncHeads();
    const evidence=this.state.evidence.map(e=>({...e,validity:this.evidenceValidity(e)}));
    const decisions=await Promise.all(this.state.decisionComponents.map(async c=>({...c,stale:!['resolved','deferred'].includes(c.status)&&c.basis_hash!==await this.basis(c)})));
    const active=this.activeRevisions();const total=active.length;const required=decisions.filter(d=>!['resolved','deferred'].includes(d.status)).length+(this.state.discovery.conventional_review_ids?.length??0);
    return {...this.state,revisions:this.state.revisions.map(r=>({...r,stale:!active.includes(r)})),evidence,decisionComponents:decisions,summary:{proposals:total,decisionsRequired:required,contextAnswersRecorded:this.state.tasks.filter(t=>t.question&&t.authorization).length,pendingClarifications:this.state.tasks.filter(t=>t.question&&!t.authorization).length,initialDecisions:this.state.decisionComponents.length,compressionRatio:total?(this.state.decisionComponents.length+(this.state.discovery.conventional_review_ids?.length??0))/total:0,graphDecisions:this.state.decisionComponents.length,conventionalReview:this.state.discovery.conventional_review_ids?.length??0,independentWork:this.state.discovery.ungrouped_revision_ids?.length??0,comparisonsAvoided:Math.max(0,this.state.metrics.possibleComparisons-this.state.metrics.comparisons),traceableRationale:total?active.filter(r=>r.provenance_state!=='unknown').length/total:0,staleEvidence:evidence.filter(e=>e.validity.status==='stale').length}};
  }
}
