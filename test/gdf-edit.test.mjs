import test from 'node:test';
import assert from 'node:assert/strict';
import {createBlankGdf,constructGdf} from '../lib/gdf-authoring.mjs';
import {createSymbol} from '../lib/gdf-symbol-editor.mjs';
import {editDrawingGraphics} from '../lib/gdf-drawing-editor.mjs';
import {parseGdfGeometry} from '../lib/gdf-geometry.mjs';
import {editGdfGeometry} from '../lib/gdf-editor.mjs';
import {sha256} from '../lib/workspace.mjs';

test('independently specified line translation changes only decoded coordinate words',()=>{
 const bytes=editDrawingGraphics(createBlankGdf(),[{operation:'add_line',x1:200,y1:1104,x2:360,y2:1040}]).buffer;
 const line=parseGdfGeometry(bytes).sheet.drawingLines[0];
 const next=editGdfGeometry(bytes,[{recordOffset:line.offset,operation:'translate',dx:16,dy:-8}]).buffer;
 const after=parseGdfGeometry(next).sheet.drawingLines[0];
 assert.deepEqual(after.start,{x:216,y:1096});assert.deepEqual(after.end,{x:376,y:1032});
 for(let i=0;i<bytes.length;i++)if(i<line.offset+1||i>line.offset+8)assert.equal(next[i],bytes[i]);
});

test('custom symbol geometry supports orientation changes and rejects invalid batches atomically',()=>{
 const symbol=createSymbol({name:'CUSTOM_GATE',width:64,height:32,pins:[{name:'A',attributeName:'ISTUB',x:0,y:16,labelX:8,labelY:17}]}).buffer;
 const bytes=constructGdf(createBlankGdf(),[{operation:'add_symbol',symbolPath:'custom.sym',symbolSha256:sha256(symbol),name:'gate',x:128,y:256}],()=>({path:'custom.sym',bytes:symbol})).buffer;
 const before=sha256(bytes),placement=parseGdfGeometry(bytes).placements[0];
 const next=editGdfGeometry(bytes,[{recordOffset:placement.offset,operation:'set_orientation',orientation:7}]).buffer;
 assert.equal(parseGdfGeometry(next).placements[0].transform.code,7);
 assert.throws(()=>editGdfGeometry(bytes,[{recordOffset:placement.offset,operation:'translate',dx:16,dy:0},{recordOffset:1,operation:'translate',dx:16,dy:0}]));
 assert.equal(sha256(bytes),before);
});
