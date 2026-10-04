import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {getCapabilities} from '../core/capabilities.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const statuses=new Set(['SUPPORTED','PARTIAL','EXPERIMENTAL','UNSUPPORTED']);
const text=value=>typeof value==='string'&&value.trim().length>0;

export async function checkRegistry(registry){
  const ids=new Set(),files=new Map();
  for(const entry of [...registry.capabilities,...registry.acceptance_gate]){
    if(!text(entry.id)||ids.has(entry.id))throw new Error('Invalid or duplicate capability ID');ids.add(entry.id);
    if(!statuses.has(entry.status)||!text(entry.title)||!text(entry.scope)||!text(entry.limits))throw new Error('Capability status, scope and limits must be explicit: '+entry.id);
    if(entry.status==='SUPPORTED'&&!entry.tests?.length)throw new Error('Supported claims need test witnesses: '+entry.id);
    for(const witness of entry.tests??[]){
      if(!/^tests\/[a-z0-9-]+\.test\.mjs$/.test(witness.file))throw new Error('Invalid test witness path: '+witness.file);
      if(!files.has(witness.file)){
        const source=await readFile(path.join(root,witness.file),'utf8');
        files.set(witness.file,new Set([...source.matchAll(/test\(\s*(['"])((?:\\.|[^\\])*?)\1/g)].map(match=>match[2].replace(/\\(['"\\])/g,'$1'))));
      }
      if(!files.get(witness.file).has(witness.title))throw new Error('Missing test witness: '+witness.file+' '+witness.title);
    }
  }
  return {capabilities:registry.capabilities.length,gate_cases:registry.acceptance_gate.length,witness_files:files.size};
}
const clean=value=>String(value).replaceAll('|','\\|').replaceAll('\n',' ');
export function renderRegistry(registry){
  const rows=entries=>entries.map(entry=>`| ${clean(entry.title)} | **${entry.status}** | ${clean(entry.scope)} | ${clean(entry.limits)} | ${(entry.tests??[]).map(w=>`[${clean(w.title)}](../${w.file})`).join('<br>')||'No operational test witness'} |`).join('\n');
  return '# Capability registry\n\nGenerated from `core/capabilities.mjs`; API and the secondary product dialog use the same source. Run `node scripts/check-capabilities.mjs --write` after changing it. Tests reject drift or supported claims with missing witnesses.\n\n'+registry.verification_scope+'\n\n'+registry.statuses.map(s=>`- **${s.id}:** ${s.description}`).join('\n')+'\n\n## Twelve-workflow local acceptance gate\n\n| Workflow | Status | Scope | Limits | Automated witnesses |\n|---|---|---|---|---|\n'+rows(registry.acceptance_gate)+'\n\n## Individual capabilities\n\n| Capability | Status | Scope | Limits | Automated witnesses |\n|---|---|---|---|---|\n'+rows(registry.capabilities)+'\n\nSee [the nineteen-domain delivery plan](product-roadmap.md), [workflow API guide](workflows.md) and [implementation briefing](implementation-briefing.md). Supported status is bounded by the recorded scope; it does not claim arbitrary semantic understanding or verified live Cloudflare services.\n';
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const registry=getCapabilities();const result=await checkRegistry(registry);
  if(process.argv.includes('--write'))await writeFile(path.join(root,'docs/capabilities.md'),renderRegistry(registry));
  else if(await readFile(path.join(root,'docs/capabilities.md'),'utf8')!==renderRegistry(registry))throw new Error('Capability docs are stale; run with --write');
  console.log(JSON.stringify(result));
}
