import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { forgeGuidance } from '../src/guidance.ts'
import { pickSymbol } from '../src/augment.ts'
import { indexerGlobSearch, indexerGrepSearch, resetIndexer } from '../src/indexer-client.ts'
const modules = process.env.DSH_FORGE_HOST_MODULES
if (!modules) {
 console.log('run-review-search-host-contracts: SKIPPED host integration (set DSH_FORGE_HOST_MODULES)')
 process.exit(0)
}
const host = await import(pathToFileURL(path.join(modules, '@deepseek-ai/dsh-tool-fs-search/lib/index.js')).href)
const { rgPath } = await import(pathToFileURL(path.join(modules, '@vscode/ripgrep/lib/index.js')).href)
let passed = 0, failed = 0
async function check(name, run) { try { await run(); console.log(`ok ${++passed} - ${name}`) } catch (error) { failed++; console.error(`not ok - ${name}: ${error.message}`) } }
const root = mkdtempSync(path.join(tmpdir(), 'forge-search-contract-'))
const write = (name, text) => { const file=path.join(root,name); mkdirSync(path.dirname(file),{recursive:true}); writeFileSync(file,text); utimesSync(file,new Date(1700000000000),new Date(1700000000000)); return file }
const rg = (args) => { const out=spawnSync(rgPath,args,{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024}); assert.ok(out.status===0||out.status===1,out.stderr); return out.stdout }
try {
 if(process.env.DSH_FORGE_LEGACY_INDEXER_BIN) await check('legacy helper replies without complete marker decline safely',async()=>{
  const original=process.env.DSH_FORGE_INDEXER_BIN
  process.env.DSH_FORGE_INDEXER_BIN=process.env.DSH_FORGE_LEGACY_INDEXER_BIN
  await resetIndexer()
  try {
   assert.equal(await indexerGlobSearch(root,root,'*.txt'),null)
   assert.equal(await indexerGrepSearch(root,root,'needle'),null)
  } finally {
   if(original===undefined) delete process.env.DSH_FORGE_INDEXER_BIN
   else process.env.DSH_FORGE_INDEXER_BIN=original
   await resetIndexer()
  }
 })
 for(let i=0;i<140;i++) write(`same/file-${String(i).padStart(3,'0')}.txt`,'needle\n')
 for(const name of ['same/Zebra.txt','same/apple.txt','same/nested/Beta.txt','same/nested/alpha.txt','same/nested-v2/a.txt']) write(name,'needle\n')
 write('many.log',Array.from({length:700},(_,i)=>`needle ${i}\n`).join(''))
 write('.hidden.log','needle hidden\n')
 await check('native glob returns the complete host value above 100 and identical equal-mtime order',async()=>{
  const expected=rg(host.buildGlobCommand({pattern:'*.txt'})).split(/\r?\n/).filter(Boolean).map(p=>host.toWorkdirRelative(path.resolve(root,p),root))
  const actual=await indexerGlobSearch(root,root,'*.txt')
  assert.ok(actual,'native glob must answer the bounded fixture')
  assert.deepEqual(actual,expected)
  assert.equal(actual.length,145)
 })
 await check('native grep returns complete host value above 250 including later matches in one file',async()=>{
  const expected=host.parseGrepMatches(rg(host.buildGrepCommand({pattern:'needle',path:root})))
  const actual=await indexerGrepSearch(root,root,'needle')
  assert.ok(actual,'native grep must answer the bounded fixture')
  assert.equal(actual.length,845)
  const key=m=>`${m.path}\u0000${m.lineNumber}`
  const normalized=items=>items.map(m=>({...m,path:host.toWorkdirRelative(path.resolve(root,m.path),root)})).sort((a,b)=>key(a).localeCompare(key(b)))
  assert.deepEqual(normalized(actual),normalized(expected))
 })
 await check('native search declines an over-budget complete value instead of returning a head',async()=>{
  write('large.log','needle '+ 'x'.repeat(20_000_001)+'\n')
  assert.equal(await indexerGrepSearch(path.join(root,'large.log'),root,'needle'),null)
 })
 await check('fallback guidance only advertises outline and definitions, never removed source-read syntax',()=>{
  const text=forgeGuidance(['read'],{symbolRead:false})
  assert.ok(text.includes('view=outline')&&text.includes('view=definitions'))
  assert.ok(!text.includes('path=<file>#'))
 })
 await check('ambiguous symbols never suggest nonexistent occurrence parameter',()=>{
  const result=pickSymbol([0,1].map(startOffset=>({qualifiedName:'overload',kind:'function',startLine:startOffset+1,endLine:startOffset+1,startOffset})),'overload')
  assert.ok(result.problem)
  assert.ok(!result.problem.includes('occurrence='))
  assert.match(result.problem,/outline|line|offset/)
 })
} finally { await resetIndexer(); rmSync(root,{recursive:true,force:true}) }
console.log(`${passed} passed; ${failed} failed`)
process.exitCode=failed?1:0
