import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {PlainMcpClient} from './helpers/plain-mcp.mjs';

test('plain stdio client discovers all tools and reads both installed guides',async()=>{
 const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'mp2-public-protocol-'));
 const client=new PlainMcpClient(workspace);
 try{
  const initialized=await client.initialize();assert.equal(initialized.serverInfo.name,'maxplus2-mcp');
  const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(initialized.serverInfo.version,pkg.version);
  const {tools}=await client.request('tools/list');assert.equal(tools.length,68);assert.equal(new Set(tools.map(t=>t.name)).size,68);
  for(const tool of tools){assert.equal(tool.inputSchema.type,'object');assert.ok(tool.description);assert.ok(tool.annotations);}
  const {resources}=await client.request('resources/list');assert.equal(resources.length,2);
  for(const resource of resources){const result=await client.request('resources/read',{uri:resource.uri});assert.ok(result.contents[0].text.length>500);assert.equal(result.contents[0].mimeType,'text/markdown');}
  const invalid=await client.request('tools/call',{name:'project_read_file',arguments:{workspace,path:'../outside.vhd'}});assert.equal(invalid.isError,true);
 }finally{await client.close();fs.rmSync(workspace,{recursive:true,force:true});}
});
