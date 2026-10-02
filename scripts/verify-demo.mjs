import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createDemo} from './demo.mjs';
import {git} from '../server/git.mjs';
const root=await mkdtemp(path.join(os.tmpdir(),'converge-report-'));
try{
 const {engine,state,adapter}=await createDemo(root);const before=await engine.view();
 const resolve=async id=>{const c=engine.component(id);return engine.serial(()=>engine.resolve(id,{alternative_id:c.alternatives[0].id,basis_hash:c.basis_hash,expected_canonical_head:c.canonical_head_seen,rationale:'Protect the payment provider and keep the established dollars contract.'},'verified-demo-owner'));};
 await resolve('retry-policy');let rejected=false;try{await resolve('currency-contract');}catch(e){assert.equal(e.code,'DECISION_STALE');rejected=true;}assert.equal(rejected,true);
 const stale=(await engine.view()).summary.staleEvidence;await engine.serial(()=>engine.refreshDecision('currency-contract'));await resolve('currency-contract');
 for(const repo of state.repositories){const dest=path.join(root,'clones',repo.id);await mkdir(path.dirname(dest),{recursive:true});await git(root,['clone','--quiet',adapter.dir(repo),dest]);assert.equal(await git(dest,['rev-parse','HEAD']),repo.head);await git(dest,['fsck','--full']);}
 const report={generated_at:new Date().toISOString(),scope:'Deterministic local Git fixture; live Artifacts behavior is not verified.',candidate_proposals:8,concurrent_producers:5,repositories:2,human_decisions_required:2,decision_compression_ratio:before.summary.compressionRatio,automatic_actions_later_reversed:state.metrics.automaticReversals,incorrect_duplicate_classifications:state.relationships.filter(r=>r.type==='implementation_equivalent').length===1?0:1,stale_evidence_accepted:state.metrics.staleEvidenceAccepted,canonical_CAS_failures_handled:state.metrics.casFailures,previously_valid_evidence_now_stale:stale,producer_intent_traceability:before.summary.traceableRationale,analysis_latency_ms:state.metrics.analysisLatencyMs,relationship_comparisons:state.metrics.comparisons,relationship_comparisons_avoided:before.summary.comparisonsAvoided,resolved_decisions:state.operations.filter(o=>o.status==='applied').length,ordinary_git_clone_and_fsck:'passed',semantic_interaction:'$10 produces 10 cents in the rejected composed contract',limits:['Structural validation and one contract fixture do not establish global correctness.','No live Cloudflare account is configured.','Cross-repository updates are not atomic.']};
 await writeFile(new URL('../docs/demo-report.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await rm(root,{recursive:true,force:true});}
