import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,utimesSync,rmSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
const temp=mkdtempSync(path.join(os.tmpdir(),'forge-outline-'))
process.env.DSH_FORGE_DATA_DIR=path.join(temp,'private')
const workspace=path.join(temp,'work');mkdirSync(workspace)
const {createReadTool}=await import('../src/tools-read.ts')
const {defineForgeTool}=await import('../src/host.ts')
const {OutlineOutput,outlineQuery}=await import('../src/outline-output.ts')
const {parseFile,flattenSymbols,findSymbol}=await import('../src/ast.ts')
const {ToolRuntime}=await import('@deepseek-ai/dsh-tools')
const factory=createReadTool(),tool=defineForgeTool(factory)
const exec={token:{},agent:{session:{header:{cwd:workspace,id:'outline-test'}}}}
const runtime=Object.create(ToolRuntime.prototype);runtime.canonicalResults=new WeakMap();runtime.concludingExecutions=new WeakSet()
let groups=0
const write=(file,text)=>writeFileSync(path.join(workspace,file),text)
async function test(name,fn){await fn();console.log('PASS',name);groups++}
async function call(args,context=exec){
 const value=await tool.execute({view:'outline',...args},context)
 const result=runtime.createSuccessResult({...context,arguments:{view:'outline',...args}},tool,value)
 assert.ok(Buffer.byteLength(JSON.stringify(value))<=12288)
 assert.equal(value.page.returned,value.items.length)
 assert.equal(value.page.complete,!value.page.nextCursor)
 assert.deepEqual(result.value.items,value.items)
 assert.ok(Buffer.byteLength(result.content.map(p=>p.text).join('\n'))<=12288)
 return value
}
async function all(args){
 let cursor,offset=0,snapshot,total;const items=[],pages=[]
 do{
  const page=await call({...args,...(cursor?{cursor}:{})})
  snapshot??=page.page.snapshot;total??=page.page.total
  assert.equal(page.page.snapshot,snapshot);assert.equal(page.page.total,total);assert.equal(page.page.offset,offset)
  items.push(...page.items);offset+=page.items.length;pages.push(page);cursor=page.page.nextCursor
  if(cursor) assert.ok(page.items.length)
 }while(cursor)
 assert.equal(items.length,total)
 return {items,pages}
}
const names=items=>items.map(x=>x.qualifiedName)
try{
write('shape.ts',`export interface Service { id: string; run(): void; options: { flag: boolean } }
export class Store {
  field = 1;
  save() { const local = { hidden: 1 }; return { result: local }; }
  static load() { function helper() { return { deep: 1 }; } return helper(); }
}
export const api = { version: 1, nested: { flag: true }, run() { return { hiddenResult: true }; }, arrow: () => ({ hiddenArrow: true }) };
export function outer() { function inner() { return 1; } return { secret: 1 }; }
export const fn = () => ({ inside: 1 });
`)
await test('declaration view preserves containers and members while hiding callable internals',async()=>{
 const result=await all({path:'shape.ts'}), n=names(result.items)
 for(const name of ['Service','Service.id','Service.run','Store','Store.field','Store.save','Store.load','api','api.version','api.nested','api.nested.flag','api.run','api.arrow','outer','fn']) assert.ok(n.includes(name),`${name}: ${n}`)
 assert.ok(!n.some(name=>/hidden|secret|inside|inner|helper|result/.test(name)))
 assert.equal(result.pages[0].page.filters.scope,'declarations')
 const parsed=await parseFile(path.join(workspace,'shape.ts'))
 assert.ok(flattenSymbols(parsed.value.symbols).length>result.items.length)
 assert.ok(findSymbol(parsed.value.symbols,'outer.inner').length,'hidden definitions remain available to symbol reads')
})
await test('all view pages reproduce the complete extracted tree with exact ranges',async()=>{
 const result=await all({path:'shape.ts',scope:'all',limit:3})
 const parsed=await parseFile(path.join(workspace,'shape.ts'))
 const expected=flattenSymbols(parsed.value.symbols)
 assert.deepEqual(result.items.map(s=>[s.qualifiedName,s.startLine,s.endLine]),expected.map(s=>[s.qualifiedName,s.startLine,s.endLine]))
 assert.ok(result.pages.length>1)
 assert.ok(names(result.items).includes('outer.inner'))
})
await test('explicit kind traverses internals; explicit declarations scope still limits them',async()=>{
 const full=await all({path:'shape.ts',kind:'field'}),limited=await all({path:'shape.ts',kind:'field',scope:'declarations'})
 assert.equal(full.pages[0].page.filters.scope,'all')
 assert.ok(full.items.length>limited.items.length)
 assert.ok(full.items.every(s=>s.kind==='field'))
 assert.ok(!names(limited.items).some(s=>/hidden|secret|inside/.test(s)))
 const none=await call({path:'shape.ts',kind:'trait'})
 assert.equal(none.page.total,0);assert.equal(none.page.complete,true)
 assert.match(factory.output.render({view:'outline'},none)[0].text,/no symbols matched.*\n.*kind=trait/s)
})
await test('depth is a separate choice; default includes class methods but depth=1 does not',async()=>{
 const result=await all({path:'shape.ts',depth:1})
 assert.ok(result.items.every(s=>s.level===1));assert.ok(!names(result.items).includes('Store.save'))
 const methods=await all({path:'shape.ts',kind:'method',depth:2})
 assert.ok(names(methods.items).includes('Store.save'))
})
await test('500 declarations and byte-limited pages visit each stable address once',async()=>{
 write('large.js',Array.from({length:500},(_,i)=>`function f${i}(){return {value:${i}}}`).join('\n'))
 const result=await all({path:'large.js',limit:200})
 assert.deepEqual(names(result.items),Array.from({length:500},(_,i)=>`f${i}`))
 assert.ok(result.pages.length>3);assert.ok(result.pages.every(p=>p.items.length<200))
 assert.equal(result.pages[0].page.available,1000)
})
await test('duplicate occurrence identities survive filters and page boundaries',async()=>{
 write('duplicate.js','function same() {}\nfunction same() {}\nclass C { same() {} }\n')
 const result=await all({path:'duplicate.js',limit:1})
 assert.deepEqual(result.items.filter(s=>s.qualifiedName==='same').map(s=>s.occurrence),[1,2])
 const filtered=await all({path:'duplicate.js',kind:'function',limit:1})
 assert.deepEqual(filtered.items.map(s=>s.occurrence),[1,2])
 assert.match(factory.output.render({view:'outline'},filtered.pages[1])[0].text,/#2/)
})
await test('cursors reject changed source even if size, mtime and selected declaration remain the same',async()=>{
 write('change.js','function first(){return {a:1}}\nfunction second(){}\n')
 const args={path:'change.js',limit:1},first=await call(args)
 const filename=path.join(workspace,'change.js'),st=statSync(filename)
 write('change.js',readFileSync(filename,'utf8').replace('a:1','b:2'));utimesSync(filename,st.atime,st.mtime)
 await assert.rejects(tool.execute({view:'outline',...args,cursor:first.page.nextCursor},exec),/source changed/)
 assert.equal((await call(args)).page.total,2)
})
await test('cursor path, workspace, scope, depth, kind and limit cannot be mixed',async()=>{
 const args={path:'large.js',kind:'function,method',limit:1},first=await call(args),cursor=first.page.nextCursor
 const next=await call({path:'large.js',kind:'method,function',cursor})
 assert.equal(next.items[0].qualifiedName,'f1')
 const retry=await call({...args,cursor});assert.deepEqual(retry.items,next.items)
 for(const fields of [{path:'shape.ts'},{scope:'declarations'},{depth:1},{kind:'function'},{limit:2}]) {
  await assert.rejects(tool.execute({view:'outline',...args,cursor,...fields},exec),/does not match/)
 }
 const foreign=path.join(temp,'foreign');mkdirSync(foreign);writeFileSync(path.join(foreign,'large.js'),readFileSync(path.join(workspace,'large.js')))
 await assert.rejects(tool.execute({view:'outline',...args,cursor},{...exec,agent:{session:{header:{cwd:foreign}}}}),/does not match/)
})
await test('expired and evicted cursors fail explicitly',async()=>{
 let now=100;const output=new OutlineOutput(()=>now)
 const source={items:Array.from({length:3},(_,i)=>({name:`f${i}`,qualifiedName:`f${i}`,kind:'function',startLine:i+1,endLine:i+1,level:1,occurrence:1})),lang:'javascript',partial:false,path:'fixture.js',snapshot:'hash',available:3}
 const first=output.page(source,{scope:'declarations',limit:1})
 now+=30*60_000
 assert.throws(()=>output.page(source,{scope:'declarations',cursor:first.page.nextCursor}),/expired|unknown/)
 const old=output.page(source,{scope:'all',limit:1})
 for(let i=0;i<129;i++)output.page(source,{scope:'all',limit:1})
 assert.throws(()=>output.page(source,{scope:'all',cursor:old.page.nextCursor}),/expired|unknown/)
})
await test('invalid output arguments are rejected before reading a file',async()=>{
 let reads=0;const context={...exec,beginNativeRead:async()=>{reads++;throw Error('read should not happen')}}
 for(const fields of [{scope:'bad'},{depth:0},{depth:21},{depth:'2'},{limit:0},{limit:201},{limit:1.5},{cursor:''},{kind:'function,'},{kind:'bogus'},{kind:3}]) {
  const value=await factory.execute({view:'outline',path:'shape.ts',...fields},context)
  assert.ok(value.error);assert.doesNotMatch(value.error,/read should not happen/)
 }
 assert.equal(reads,0)
 assert.deepEqual(outlineQuery({kind:' method, function,method '}),{scope:'all',kind:'function,method'})
})
await test('partial and empty parses keep explicit completeness and warning semantics',async()=>{
 write('empty.js','// no declarations\n')
 const empty=await call({path:'empty.js'});assert.equal(empty.page.total,0);assert.equal(empty.page.available,0)
 write('broken.js','function good() {}\nfunction broken( {\n')
 const broken=await call({path:'broken.js'});assert.match(broken.note,/parse had errors/)
 assert.match(factory.output.render({view:'outline'},broken)[0].text,/extracted symbols only/)
})
await test('long names remain intact or fail with a source range instead of silently truncating identity',async()=>{
 const normal='名'.repeat(350),huge='巨'.repeat(1800)
 write('names.js',`function ${normal}(){}\n`)
 const value=await call({path:'names.js'});assert.equal(value.items[0].qualifiedName,normal)
 write('huge.js',`function ${huge}(){}\n`)
 const failed=await factory.execute({view:'outline',path:'huge.js'},exec)
 assert.match(failed.error,/L1-1 exceeds.*budget/);assert.ok(failed.error.length<200)
})
await test('native read provider supplies parsing bytes and gets a finished observation',async()=>{
 write('provider.ts','export class Provider { read() { return {hidden:1} } }')
 let finished=0
 const value=await call({path:'alias.ts'},{...exec,beginNativeRead:async()=>({path:path.join(workspace,'provider.ts'),finish:async()=>{finished++}})})
 assert.equal(finished,1);assert.ok(names(value.items).includes('Provider.read'));assert.ok(!names(value.items).some(n=>n.includes('hidden')))
})
await test('Python/Rust/Go/Lua members survive declaration browsing',async()=>{
 const fixtures=[
  ['sample.py','class Store:\n    def save(self):\n        def local():\n            return 1\n        return local()\n',['Store','Store.save']],
  ['sample.rs','pub struct Store { pub value: i32 }\nimpl Store { pub fn save(&self) { fn local() {} } }\n',['Store','Store::save']],
  ['sample.go','package test\ntype Store struct { Value int }\nfunc (s Store) Save() {}\n',['Store','Store.Save']],
  ['sample.lua','local api = { version = 1, run = function() return { hidden = 1 } end }\n',['api','api.version','api.run']],
 ]
 for(const [file,source,expected] of fixtures){write(file,source);const value=await all({path:file});for(const n of expected)assert.ok(names(value.items).includes(n),`${file}: ${names(value.items)}`);assert.ok(!names(value.items).some(n=>/local|hidden/.test(n)))}
})
console.log(`${groups} outline output groups passed, 0 failed`)
}finally{rmSync(temp,{recursive:true,force:true})}
