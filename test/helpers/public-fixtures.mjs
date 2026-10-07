import {createBlankGdf,constructGdf} from '../../lib/gdf-authoring.mjs';
import {createSymbol} from '../../lib/gdf-symbol-editor.mjs';
import {sha256} from '../../lib/workspace.mjs';
/** Independent public drawing: each named conductor has two custom interface pins. */
export function paginationFixture(count=49){
 const symbol=createSymbol({name:'PUBLIC_PORT',width:32,height:32,pins:[{name:'P',attributeName:'ISTUB',x:0,y:16,labelX:8,labelY:17}]}).buffer;
 const operations=[];
 for(let i=0;i<count;i++){
  const y=i*24;
  for(const [name,x] of [['left',0],['right',128]])operations.push({operation:'add_symbol',symbolPath:'public-port.sym',symbolSha256:sha256(symbol),name:name+i,x,y});
  operations.push({operation:'add_wire',x1:0,y1:y+16,x2:128,y2:y+16,nodeName:'NET'+i});
 }
 return constructGdf(createBlankGdf({height:2048}),operations,()=>({path:'public-port.sym',bytes:symbol})).buffer;
}
