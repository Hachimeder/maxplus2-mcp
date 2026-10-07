import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {advancedFileTools} from '../lib/advanced-file-tools.mjs';
import {sha256} from '../lib/workspace.mjs';
const edif='(edif demo (edifVersion 2 0 0) (edifLevel 0) (keywordMap (keywordLevel 0)) (library work (cell demo (cellType GENERIC) (view logic (viewType NETLIST) (interface (port CLK (direction INPUT)) (port DONE (direction OUTPUT))) (contents)))) (design demo (cellRef demo (libraryRef work))))';
test('compiled port inspection and SCF creation accept EDIF above 4 MiB, retain 32 MiB and hash guards',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'maxplus-port-limit-'));
 try {
  const tools=advancedFileTools({defaultWorkspace:root,resolveAcf:p=>p});
  const call=(name,args)=>tools.find(t=>t.name===name).handler(args);
  const bytes=Buffer.from(edif+' '.repeat(4*1024*1024),'latin1');
  fs.writeFileSync(path.join(root,'large.edo'),bytes);
  const ports=call('scf_compiled_ports',{path:'large.edo',limit:100});
  assert.equal(ports.complete,true);assert.equal(ports.sha256,sha256(bytes));
  const args={path:'demo.scf',edifPath:'large.edo',edifSha256:ports.sha256,durationNs:100};
  const preview=call('scf_from_compiled_create',args);
  assert.equal(preview.preview,true);
  assert.equal(fs.existsSync(path.join(root,'demo.scf')),false);
  call('scf_from_compiled_create',{...args,signals:['CLK'],confirm:true});
  const existing=fs.readFileSync(path.join(root,'demo.scf'));
  const importArgs={path:'demo.scf',expectedSha256:sha256(existing),edifPath:'large.edo',edifSha256:ports.sha256,signals:['DONE']};
  const imported=call('scf_ports_import',importArgs);
  assert.ok(imported);
  assert.deepEqual(fs.readFileSync(path.join(root,'demo.scf')),existing);
  assert.throws(()=>call('scf_ports_import',{...importArgs,edifSha256:'0'.repeat(64),confirm:true}),/EDIF changed/);
  assert.deepEqual(fs.readFileSync(path.join(root,'demo.scf')),existing);
  call('scf_ports_import',{...importArgs,confirm:true});
  assert.notDeepEqual(fs.readFileSync(path.join(root,'demo.scf')),existing);
  assert.throws(()=>call('scf_from_compiled_create',{...args,edifSha256:'0'.repeat(64)}),/EDIF changed/);
  const fd=fs.openSync(path.join(root,'oversize.edo'),'w');fs.ftruncateSync(fd,32*1024*1024+1);fs.closeSync(fd);
  assert.throws(()=>call('scf_compiled_ports',{path:'oversize.edo'}),/32 MiB/);
  fs.writeFileSync(path.join(root,'large.scf'),bytes);
  assert.throws(()=>call('scf_editor_metadata',{path:'large.scf'}),/4 MiB/);
  assert.throws(()=>call('scf_compiled_ports',{path:'large.scf'}),/\.edo/);
 } finally {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));
  fs.rmSync(root,{recursive:true,force:true});
 }
});
