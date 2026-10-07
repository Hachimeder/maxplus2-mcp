import test from 'node:test';
import assert from 'node:assert/strict';
import {createBlankGdf} from '../lib/gdf-authoring.mjs';
import {parseGdfGeometry} from '../lib/gdf-geometry.mjs';
import {editDrawingGraphics} from '../lib/gdf-drawing-editor.mjs';
test('root drawing lines, circles and arcs can be created, resized, restyled and deleted',()=>{
 const blank=createBlankGdf(),r=editDrawingGraphics(blank,[{operation:'add_line',x1:0,y1:0,x2:64,y2:64},{operation:'add_circle',x:128,y:128,radius:24,filled:true},{operation:'add_arc',cx:256,cy:256,startX:288,startY:256,endX:256,endY:288,radius:32,startAngleDegrees:0,sweepAngleDegrees:90}]),g=parseGdfGeometry(r.buffer);
 assert.equal(g.sheet.primitives.length,3);const [line,arc,circle]=g.sheet.primitives;assert.equal(line.opcode,'m');assert.equal(circle.kind,'circle');assert.equal(arc.kind,'arc');
 const changed=editDrawingGraphics(r.buffer,[{operation:'set_circle',recordOffset:circle.offset,x:160,y:160,radius:40},{operation:'set_graphic_style',recordOffset:arc.offset,startDot:true},{operation:'delete_graphic',recordOffset:line.offset}]);assert.equal(parseGdfGeometry(changed.buffer).sheet.primitives.length,2);assert.deepEqual(blank,createBlankGdf());
 assert.throws(()=>editDrawingGraphics(r.buffer,[{operation:'translate',recordOffset:circle.offset,dx:32768,dy:0}]),/integer/);
});
test('unsupported offsets and duplicate targets leave input bytes unchanged',()=>{
 const b=editDrawingGraphics(createBlankGdf(),[{operation:'add_circle',x:0,y:0,radius:16}]).buffer,copy=Buffer.from(b),p=parseGdfGeometry(b).sheet.primitives[0];
 assert.throws(()=>editDrawingGraphics(b,[{operation:'delete_graphic',recordOffset:999}]),/primitive/);
 assert.throws(()=>editDrawingGraphics(b,[{operation:'translate',recordOffset:p.offset,dx:8,dy:0},{operation:'delete_graphic',recordOffset:p.offset}]),/once/);assert.deepEqual(b,copy);
});
