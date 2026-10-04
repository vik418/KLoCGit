import {DomainError} from '../core/hash.mjs';
import {getCapabilities} from '../core/capabilities.mjs';

// Provider-neutral routing only. The caller owns authentication, serialization
// and persistence. Producers never select audit actors or trusted check sources.
const fields=(value,names)=>Object.fromEntries(names.filter(key=>Object.prototype.hasOwnProperty.call(value??{},key)).map(key=>[key,value[key]]));
const policy=value=>fields(value,['minApprovals','allowSelfApproval','requiredChecks']);
const workflowPath=path=>path==='/api/capabilities'||path==='/api/merge-requests'||path.startsWith('/api/merge-requests/')||path==='/api/merge-queue'||path.startsWith('/api/merge-queue/')||path==='/api/reviews/prepare'||path==='/api/reverts/prepare'||/^\/api\/repositories\/[^/]+\/policy$/.test(path);
function service(engine,key){if(!engine[key])throw new DomainError('WORKFLOW_UNAVAILABLE','The requested coordination workflow is unavailable',503);return engine[key];}
function currentRequest(engine,id,input){
  const request=service(engine,'mr').get(id);
  if(input.expected_revision_id!==undefined&&input.expected_revision_id!==request.revision_id)throw new DomainError('MERGE_REQUEST_STALE','The merge request revision changed. Review the current request.',409);
  if(input.expected_version!==undefined&&![request.version,request.event_id,request.version_id].includes(input.expected_version))throw new DomainError('MERGE_REQUEST_STALE','The merge request changed. Review its current version.',409);
  return request;
}

/** Returns a domain result, or null when another API dispatcher owns the route. */
export async function handleWorkflowRequest(engine,{method,url,input={},actor}){
  const parsed=url instanceof URL?url:new URL(url,'http://coordination.internal'),path=parsed.pathname;
  if(!workflowPath(path))return null;
  if(typeof actor!=='string'||!actor.trim())throw new DomainError('UNAUTHENTICATED','An authenticated coordination actor is required',401);
  if(!input||typeof input!=='object'||Array.isArray(input))throw new DomainError('INVALID_REQUEST','Workflow input must be a JSON object');
  if(path==='/api/capabilities'){
    if(method!=='GET')throw new DomainError('METHOD_NOT_ALLOWED','Capabilities are read-only',405);
    return getCapabilities();
  }
  if(path==='/api/merge-requests'){
    const mr=service(engine,'mr');
    if(method==='GET')return {mergeRequests:mr.list()};
    if(method==='POST')return mr.open(fields(input,['repo','source_ref','source_repo','target_ref','title','description','draft','request_id']),actor);
  }
  if(path==='/api/merge-requests/reviews/batch'&&method==='POST'){
    if(!Array.isArray(input.items)||!input.items.length||input.items.length>100)throw new DomainError('INVALID_MR_INPUT','Supply between one and 100 exact merge-request reviews');
    const items=input.items.map(item=>{
      if(!item||typeof item!=='object'||Array.isArray(item))throw new DomainError('INVALID_MR_INPUT','Each batch review must be a JSON object');
      return fields(item,['mr_id','action','body','review_id','expected_revision_id','expected_version','request_id']);
    });
    return {mergeRequests:await service(engine,'mr').reviewBatch(items,actor)};
  }
  const request=path.match(/^\/api\/merge-requests\/([^/]+)(?:\/(transition|reviews|comments|checks|dependencies|prepare|validate))?$/);
  if(request){
    const mr=service(engine,'mr'),id=request[1],action=request[2];
    if(method==='GET'&&!action)return mr.get(id);
    if(method==='POST'){
      if(action==='transition'){const value=fields(input,['action','title','description','expected_version','request_id']);if(input.policy)value.policy=policy(input.policy);return mr.transition(id,value,actor);}
      if(action==='reviews')return mr.review(id,fields(input,['action','body','review_id','expected_revision_id','expected_version','request_id']),actor);
      if(action==='comments')return mr.comment(id,fields(input,['action','body','file','line','thread_id','expected_revision_id','expected_version','request_id']),actor);
      if(action==='checks')return mr.check(id,fields(input,['name','status','details','url','expected_revision_id','expected_version','request_id']),actor);
      if(action==='dependencies')return mr.dependencies(id,fields(input,['dependency_ids','expected_version','request_id']),actor);
      if(action==='prepare'){
        const snapshot=currentRequest(engine,id,input);
        if(!snapshot.revision_id)throw new DomainError('REVISION_NOT_FOUND','The merge request needs an ingested immutable revision',409);
        return engine.prepareReview({...fields(input,['title','request_id']),revision_ids:[snapshot.revision_id]},actor);
      }
      if(action==='validate'){
        const snapshot=currentRequest(engine,id,input);
        if(!snapshot.revision_id)throw new DomainError('REVISION_NOT_FOUND','The merge request needs an ingested immutable revision',409);
        const validation=await engine.validateRevision(snapshot.revision_id,{actor});
        return {mergeRequest:mr.get(id),validation};
      }
    }
  }
  if(path==='/api/merge-queue'){
    const queue=service(engine,'queue');
    if(method==='GET')return {mergeQueue:queue.list()};
    if(method==='POST')return queue.enqueue(fields(input,['request_id','component_id','alternative_id','basis_hash','expected_canonical_head','rationale','mr_basis_hash']),actor);
  }
  if(path==='/api/merge-queue/process'&&method==='POST')return service(engine,'queue').process(fields(input,['request_id']),actor);
  const cancel=path.match(/^\/api\/merge-queue\/([^/]+)\/cancel$/);
  if(cancel&&method==='POST')return service(engine,'queue').cancel(cancel[1],fields(input,['request_id']),actor);
  if(path==='/api/reviews/prepare'&&method==='POST')return engine.prepareReview(fields(input,['revision_ids','title','request_id']),actor);
  if(path==='/api/reverts/prepare'&&method==='POST')return engine.prepareRevert(fields(input,['repo','target_commit','decision_id','mainline','title','rationale','request_id']),actor);
  const repository=path.match(/^\/api\/repositories\/([^/]+)\/policy$/);
  if(repository){
    const mr=service(engine,'mr');
    if(method==='GET')return mr.getPolicy(repository[1]);
    if(method==='POST')return mr.setPolicy(repository[1],{...fields(input,['expected_version','request_id']),policy:policy(input.policy)},actor);
  }
  return null;
}
