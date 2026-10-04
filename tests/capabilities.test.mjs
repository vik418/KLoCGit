import test from 'node:test';
import assert from 'node:assert/strict';
import {getCapabilities} from '../core/capabilities.mjs';
import {checkRegistry,renderRegistry} from '../scripts/check-capabilities.mjs';
import {handleWorkflowRequest} from '../server/workflow-api.mjs';
import {readFile} from 'node:fs/promises';

test('supported capability claims have bounded scope and real automated test witnesses',async()=>{
  const registry=getCapabilities();await checkRegistry(registry);
  assert.equal(registry.acceptance_gate.length,12);
  assert.deepEqual(new Set(registry.statuses.map(status=>status.id)),new Set(['SUPPORTED','PARTIAL','EXPERIMENTAL','UNSUPPORTED']));
  assert.equal(await readFile(new URL('../docs/capabilities.md',import.meta.url),'utf8'),renderRegistry(registry),'Generated docs cannot diverge from the API/product registry');
});

test('unsupported claims cannot masquerade as supported or cite missing automated tests',async()=>{
  const missing=getCapabilities();missing.capabilities[0].tests=[];
  await assert.rejects(()=>checkRegistry(missing),/test witnesses/);
  const forged=getCapabilities();forged.capabilities[0].tests[0].title='This test does not exist';
  await assert.rejects(()=>checkRegistry(forged),/Missing test witness/);
});

test('authenticated capability API exposes read-only scoped status without producer authority',async()=>{
  const request={method:'GET',url:'https://workspace/api/capabilities',input:{actor:'forged-owner'},actor:'owner'};
  await assert.rejects(()=>handleWorkflowRequest({}, {...request,actor:''}),error=>error.status===401);
  const result=await handleWorkflowRequest({},request);assert.deepEqual(result,getCapabilities());
  result.capabilities[0].status='UNSUPPORTED';assert.notDeepEqual(result,getCapabilities());
  await assert.rejects(()=>handleWorkflowRequest({}, {...request,method:'POST'}),error=>error.status===405);
});
