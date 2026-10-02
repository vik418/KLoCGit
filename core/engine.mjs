import {hash, record, DomainError} from './hash.mjs';
const now = () => new Date().toISOString();
export function emptyState() {return {version:1,workspace:{id:'northstar',name:'Northstar',description:'Checkout reliability',mode:'local-demo',producers:[]},repositories:[],forks:[],implementations:[],operations:[],intents:[],contexts:[],proposals:[],revisions:[],relationships:[],constraints:[],evidence:[],compositions:[],decisionComponents:[],decisions:[],audit:[],events:{},refVersions:{},metrics:{comparisons:0,possibleComparisons:0,casFailures:0,staleEvidenceAccepted:0,duplicateClassifications:0,automaticReversals:0},analysis:{status:'deterministic',analyzer:'git-tree-v1',semantic:'unavailable'}};}
export class Engine {
  constructor(state,git,save=async()=>{}) {state.forks??=[];state.operations??=[];state.implementations??=[];this.state=state;this.git=git;this.save=save;this._tail=Promise.resolve();}
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
    const safeMeta={title:String(metadata.title??event.ref.split('/').at(-1)).slice(0,200),statement:String(metadata.statement??'Intent not supplied').slice(0,1000),producer:String(metadata.producer??'Git client').slice(0,100),provenance_state:metadata.provenance_state==='declared'?'declared':'unknown'};
    const proposalId=await hash({repo:repo.id,source_repo:sourceRepo.id,ref:event.ref});
    let proposal=this.state.proposals.find(p=>p.id===proposalId);
    if(!this.state.workspace.producers.includes(safeMeta.producer))this.state.workspace.producers.push(safeMeta.producer);
    if(!proposal){const intent=await record('intent',{statement:safeMeta.statement,scope:facts.scope,source:safeMeta.producer,basis:safeMeta.provenance_state==='unknown'?'inferred':'declared',created_at:now()});this.state.intents.push(intent);proposal={intent_id:intent.id,id:proposalId,repo:repo.id,source_repo:sourceRepo.id,ref:event.ref,...safeMeta,created_at:now()};this.state.proposals.push(proposal);}
    const context=await record('ctx',{items:[{type:'intent',value:safeMeta.statement,basis:safeMeta.provenance_state==='unknown'?'inferred':'declared',source:safeMeta.producer,validity_scope:facts.scope}],constraints:this.state.constraints.map(c=>c.id),canonical_heads:this.state.repositories.map(r=>({repo:r.id,head:r.head}))});
    if(!this.state.contexts.some(c=>c.id===context.id))this.state.contexts.push(context);
    const implementation=await record('impl',{repo:repo.id,tree_hash:facts.tree});if(!this.state.implementations.some(i=>i.id===implementation.id))this.state.implementations.push(implementation);
    const revision=await record('rev',{proposal_id:proposalId,implementation_ref:implementation.id,repo:repo.id,source_repo:sourceRepo.id,base_commit:facts.base,head_commit:facts.head,tree_hash:facts.tree,context_version:context.id,affected_scope:facts.scope,symbol_footprint:facts.symbols??[],provenance_state:safeMeta.provenance_state});
    if(!this.state.revisions.some(r=>r.id===revision.id))this.state.revisions.push(revision);
    this.state.events[eventId]=revision.id;this.state.refVersions[`${sourceRepo.id}:${event.ref}`]=facts.head;
    const others=this.state.revisions.filter(r=>r.repo===repo.id&&r.id!==revision.id);
    this.state.metrics.possibleComparisons+=others.length;
    for(const other of others.filter(r=>r.affected_scope.some(p=>facts.scope.includes(p))||r.tree_hash===facts.tree)) {
      this.state.metrics.comparisons++;
      const identical=other.tree_hash===facts.tree;
      const rel=await record('rel',{from_revision:other.id,to_revision:revision.id,type:identical?'implementation_equivalent':'unknown',confidence:identical?1:null,basis:'observed',analyzer_version:'git-tree-v1',evidence_refs:[],observation:identical?'Identical complete Git tree; proposal histories remain separate.':'Affected paths overlap; no semantic conclusion.'});
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
  async compose(repoId,revisionIds) {
    const repo=this.repo(repoId);const revisions=revisionIds.map(id=>this.revision(id));
    if(revisions.some(r=>r.repo!==repoId))throw new DomainError('CROSS_REPO_COMPOSITION','A Git composition belongs to one repository');
    const baseHead=repo.head;const validityHeads=Object.fromEntries(this.state.repositories.map(r=>[r.id,r.head]));
    const unique=[...new Map(revisions.map(r=>[r.tree_hash,r])).values()];
    const result=await this.git.compose(repo,baseHead,unique);
    if(result.conflict)throw new DomainError('COMPOSITION_CONFLICT','Candidate cannot be applied because the Git merge failed',422);
    const composition=await record('comp',{repo:repoId,proposal_revision_ids:[...revisionIds].sort(),base_commit:baseHead,base_tree:result.baseTree,resulting_tree:result.tree,commit:result.commit});
    if(!this.state.compositions.some(c=>c.id===composition.id))this.state.compositions.push(composition);
    const evidence=await this.validate(composition.id,repo,result.tree,result.commit,validityHeads);
    return {composition_id:composition.id,evidence_ids:[evidence.id],validation:result.conflict?'conflict':evidence.result.passed?'passed':'failed'};
  }
  async basis(component) {
    const ids=component.revision_ids;
    const relationships=this.state.relationships.filter(r=>ids.includes(r.from_revision)||ids.includes(r.to_revision));
    const alternatives=component.alternatives.map(a=>({...a,evidence:a.evidence_ids.map(id=>{const e=this.state.evidence.find(e=>e.id===id);return {id,validity:e?this.evidenceValidity(e):{status:'missing'}};})}));
    const membership=this.activeRevisions().filter(r=>component.scope.includes(r.repo)).map(r=>r.id).sort();
    return hash({component_id:component.id,membership,revisions:ids.slice().sort(),relationships:relationships.map(r=>r.id).sort(),constraints:this.state.constraints.filter(c=>c.active).map(c=>c.id).sort(),alternatives,heads:this.state.repositories.map(r=>({repo:r.id,head:r.head})).sort((a,b)=>a.repo.localeCompare(b.repo)),assumptions:component.assumptions??[]});
  }
  async refreshDecision(id) {
    const c=this.component(id);if(c.status==='resolved')return c;
    await this.syncHeads();
    for(const a of c.alternatives){const result=await this.compose(a.repo,a.revision_ids);Object.assign(a,result);}
    c.basis_hash=await this.basis(c);c.canonical_head_seen=this.repo(c.alternatives[0].repo).head;
    await this.audit('decision.basis-refreshed','coordinator',{decision_id:id,basis_hash:c.basis_hash});await this.save(this.state);return c;
  }
  async resolve(id,input,actor) {
    if(!actor)throw new DomainError('UNAUTHENTICATED','Authenticated actor required',401);
    if(this.state.operations.some(d=>['prepared','recovery-required'].includes(d.status)))throw new DomainError('RECOVERY_REQUIRED','A prior Git operation must be reconciled before advancing canonical state',409);
    const c=this.component(id);await this.syncHeads();
    const currentBasis=await this.basis(c);
    const option=c.alternatives.find(a=>a.id===input.alternative_id);if(!option)throw new DomainError('INVALID_RESOLUTION','Select a listed alternative');
    const repo=this.repo(option.repo);
    if(c.status==='resolved')throw new DomainError('DECISION_RESOLVED','This decision is already resolved',409);
    if(input.basis_hash!==c.basis_hash||input.basis_hash!==currentBasis||input.expected_canonical_head!==repo.head){this.state.metrics.casFailures++;await this.audit('decision.stale-rejected',actor,{decision_id:id});await this.save(this.state);throw new DomainError('DECISION_STALE','The canonical head or reviewed decision basis changed. Review fresh evidence before applying.',409,{current_basis_hash:currentBasis,canonical_head:repo.head});}
    const composition=this.state.compositions.find(x=>x.id===option.composition_id);
    if(option.validation!=='passed'||!composition||composition.base_commit!==repo.head)throw new DomainError('DECISION_STALE','Composition requires rebuilding against canonical head',409);
    const checks=option.evidence_ids.map(x=>this.state.evidence.find(e=>e.id===x));
    if(!checks.length||checks.some(e=>!e||this.evidenceValidity(e).status!=='current'||!e.result.passed||e.tree_hash!==composition.resulting_tree||e.subject_ref!==composition.id||e.type!=='trusted-validation'||e.source!=='platform-owned checks'))throw new DomainError('VALIDATION_REQUIRED','Fresh passing validation of the composed tree is required',422);
    const expectedHead=repo.head;
    const resolution=await record('decision',{component_id:id,proposal_revision_ids:composition.proposal_revision_ids,decision_basis_hash:currentBasis,canonical_head_seen:repo.head,resolution:option.id,rationale:String(input.rationale??'').slice(0,2000),actor,created_at:now()});
    // Persist write-ahead intent before the external Git CAS. Recovery reconciles only this exact commit.
    this.state.decisions.push(resolution);const operation={id:'operation_'+resolution.id,decision_id:resolution.id,status:'prepared',target_commit:composition.commit,expected_head:expectedHead,repo:repo.id};this.state.operations.push(operation);await this.audit('canonical.prepared',actor,{decision_id:resolution.id,expected:repo.head,target:composition.commit});await this.save(this.state);
    let updated;try{updated=await this.git.cas(repo,expectedHead,composition.commit);}catch{operation.status='recovery-required';await this.audit('canonical.recovery-required',actor,{decision_id:resolution.id});await this.save(this.state);throw new DomainError('RECOVERY_REQUIRED','Git outcome is uncertain. Reconcile the prepared operation before another canonical update.',503);}
    if(!updated){operation.status='cas-failed';this.state.metrics.casFailures++;await this.audit('canonical.cas-failed',actor,{decision_id:resolution.id});await this.save(this.state);throw new DomainError('DECISION_STALE','Git compare-and-set rejected canonical advancement',409);}
    repo.head=composition.commit;c.status='resolved';c.selected=option.id;c.resolution_id=resolution.id;operation.status='applied';
    await this.audit('canonical.updated',actor,{repo:repo.id,head:repo.head,decision_id:resolution.id,tree:composition.resulting_tree});await this.save(this.state);
    return {decision_id:resolution.id,canonical_head:repo.head,resolution:option.id};
  }
  async recover() {
    for(const operation of this.state.operations.filter(d=>['prepared','recovery-required'].includes(d.status))){
      const decision=this.state.decisions.find(d=>d.id===operation.decision_id);if(!decision)throw new DomainError('RECOVERY_REQUIRED','Prepared operation has no immutable decision',503);
      const repo=this.repo(operation.repo);const observed=await this.git.ref(repo,repo.canonical_ref);
      if(observed===operation.target_commit){operation.status='applied';repo.head=observed;const c=this.component(decision.component_id);c.status='resolved';c.selected=decision.resolution;c.resolution_id=decision.id;await this.audit('canonical.recovered','coordinator',{decision_id:decision.id,head:observed});}
      else {operation.status='recovery-required';await this.audit('canonical.recovery-required','coordinator',{decision_id:decision.id,observed});}
    }await this.save(this.state);
  }
  async view() {
    await this.syncHeads();
    const evidence=this.state.evidence.map(e=>({...e,validity:this.evidenceValidity(e)}));
    const decisions=await Promise.all(this.state.decisionComponents.map(async c=>({...c,stale:c.status!=='resolved'&&c.basis_hash!==await this.basis(c)})));
    const active=this.activeRevisions();const total=active.length;const required=decisions.filter(d=>d.status!=='resolved').length;
    return {...this.state,revisions:this.state.revisions.map(r=>({...r,stale:!active.includes(r)})),evidence,decisionComponents:decisions,summary:{proposals:total,decisionsRequired:required,initialDecisions:this.state.decisionComponents.length,compressionRatio:total?this.state.decisionComponents.length/total:0,comparisonsAvoided:Math.max(0,this.state.metrics.possibleComparisons-this.state.metrics.comparisons),traceableRationale:total?active.filter(r=>r.provenance_state!=='unknown').length/total:0,staleEvidence:evidence.filter(e=>e.validity.status==='stale').length}};
  }
}
