import {paginationFixture} from './helpers/public-fixtures.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {pageResult} from '../lib/extended-file-tools.mjs';
import {inspectGdfConnections} from '../lib/gdf-connections.mjs';
import {PlainMcpClient} from './helpers/plain-mcp.mjs';

test('root offsets do not skip nested names, pins or object-wrapped collections',()=>{
 const rows=[{name:'A',pins:[{name:'P1'},{name:'P2'}]},{name:'B',pins:[{name:'P3'},{name:'P4'}]}];
 const p=pageResult({rows,wrapped:{rows}},{offset:1,limit:1,childLimit:10});
 assert.equal(p.rows.items[0].name,'B');
 assert.deepEqual(p.rows.items[0].pins.items.map(p=>p.name),['P3','P4']);
 assert.equal(p.rows.items[0].pins.offset,0);
 assert.equal(p.wrapped.rows.items[0].name,'B');
 const q=pageResult({rows},{offset:1,limit:1,childOffset:1,childLimit:1});
 assert.equal(q.rows.items[0].name,'B');assert.equal(q.rows.items[0].pins.items[0].name,'P4');
});
test('nested response budgets reduce detail limits and keep continuation metadata',()=>{
 const p=pageResult({rows:[{children:Array.from({length:100},(_,i)=>({name:String(i),text:'x'.repeat(1024)}))}]},{limit:1,childLimit:100});
 assert.ok(JSON.stringify(p).length<=36000);assert.ok(p.childLimit<100);
 assert.equal(p.rows.items[0].children.nextOffset,p.childLimit);
 const q=pageResult({rows:[{text:'x'.repeat(1500)}]});assert.equal(q.totalTruncations,1);
});
test('ordinary stdio client reconstructs every independently generated net across pages',async()=>{
 const bytes=paginationFixture(),expected=inspectGdfConnections(bytes);
 const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'mp2-paging-fix-'));
 fs.writeFileSync(path.join(workspace,'fixture.gdf'),bytes);
 const client=new PlainMcpClient(workspace);
 try{
  await client.initialize();const tools=(await client.request('tools/list')).tools;
  for(const name of ['gdf_connections','sym_inspect','gdf_declarations','scf_structure','gdf_text_format_inspect','scf_editor_metadata','scf_compiled_ports']){
   const props=tools.find(t=>t.name===name).inputSchema.properties;assert.ok(props.childOffset&&props.childLimit);
  }
  const second=await client.call('gdf_connections',{path:'fixture.gdf',offset:1,limit:1,childLimit:100});
  assert.deepEqual(second.nets.items[0].names.items,expected.nets[1].names);
  assert.equal(second.nets.items[0].terminals.offset,0);
  assert.equal(second.nets.items[0].terminals.items.length,expected.nets[1].terminals.length);
  let offset=0;const ids=[];
  do{
   const page=await client.call('gdf_connections',{path:'fixture.gdf',offset,limit:100,childLimit:100});
   for(const row of page.nets.items){assert.equal(row.names.offset,0);assert.equal(row.terminals.offset,0);ids.push(row.id);}
   offset=page.nets.nextOffset;
  }while(offset!==null);
  assert.deepEqual(ids,expected.nets.map(n=>n.id));
 }finally{
  await client.close();
  assert.equal(path.dirname(path.resolve(workspace)),path.resolve(os.tmpdir()));
  fs.rmSync(workspace,{recursive:true,force:true});
 }
});
