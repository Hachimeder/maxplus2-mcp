/** Standard MCP image blocks shared by all transports; no host SDK dependency. */
export const MCP_IMAGES = Symbol('MCP desktop image blocks');
/** Page native controls while preserving their global indices and focus. */
export function desktopViewport(state,{textOffset=0,textLimit=60,menuOffset=0,menuLimit=60}={}) {
  if(Array.isArray(state.menus)){const all=state.menus;state={...state,menus:{items:all.slice(menuOffset,menuOffset+menuLimit).map(m=>({...m,label:m.label?.slice(0,256)})),total:all.length,offset:menuOffset,nextOffset:menuOffset+menuLimit<all.length?menuOffset+menuLimit:null}};}
  if(!state.accessibility?.elements)return state;
  const a=state.accessibility,all=a.elements;
  const rows=a.tree.split(/\r?\n/).filter(Boolean);
  let count=Math.min(textLimit,Math.max(0,all.length-textOffset));
  const make=()=>{
    const elements=all.slice(textOffset,textOffset+count).map(e=>({...e,name:e.name?.slice(0,256),value:typeof e.value==='string'?e.value.slice(0,256):e.value,valueTruncated:e.valueTruncated||typeof e.value==='string'&&e.value.length>256}));
    const selected=new Set(elements.map(e=>e.element_index));
    const tree=rows.filter(l=>selected.has(Number(/^\s*(\d+)\s/.exec(l)?.[1]))).map(l=>l.length>600?l.slice(0,600)+'…':l).join('\n');
    return {...state,accessibility:{...a,tree,elements,totalElements:all.length,textOffset,returnedElements:count,nextTextOffset:textOffset+count<all.length?textOffset+count:null,truncated:a.truncated||textOffset>0||textOffset+count<all.length}};
  };
  let result=make();
  while(count>1&&JSON.stringify({...result,screenshots:[]}).length>40000){count--;result=make();}
  return result;
}
export function desktopResult(data) {
  const images=[];
  const result={...data};
  if(data.screenshots)result.screenshots=data.screenshots.map(s=>{
    const {url,...metadata}=s;
    const match=/^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/.exec(url??'');
    const imageReturned=Boolean(match && match[2].length<=8*1024*1024);
    if(imageReturned)images.push({type:'image',mimeType:match[1],data:match[2]});
    return {...metadata,imageReturned};
  });
  Object.defineProperty(result,MCP_IMAGES,{value:images});
  return result;
}
