/** GDF NET_ID is a native decimal identity, independent of MCP DOC aliases.
 * The MAX+plus II 10.2 extractor uses signed 32-bit conversion (including wrap),
 * and compares ordinary logical instance identities across symbol definitions.
 * I/O borders use node names; WIRE is a transparent connector rather than a
 * named logical instance. See test/gdf-identities-oracle.mjs for compiler
 * evidence, including complete connected circuits with zero warnings. */
export const AUTO_NET_ID_MIN=1;
export const AUTO_NET_ID_MAX=32767;
export const isGdfIo=placement=>['INPUT','OUTPUT','BIDIR'].includes(placement.symbolName?.toUpperCase());

export function nativeGdfNetId(raw){
  if(typeof raw!=='string'||!/^[-+]?\d+$/.test(raw))return null;
  return Number(BigInt.asIntN(32,BigInt(raw)));
}

export function nativeGdfIdentityKey(placement){
  if(placement.netId===null||isGdfIo(placement)||placement.symbolName?.toUpperCase()==='WIRE')return null;
  return String(placement.netId);
}

export function assertGdfIdentities(placements){
  const aliases=new Set(),native=new Set(),ports=new Set();
  for(const p of placements){
    if(p.instanceNameSource==='hidden-DOC-alias'){
      const alias=p.instanceName?.toUpperCase();
      if(alias&&aliases.has(alias))throw new Error('Duplicate instance name in the resulting drawing');
      if(alias)aliases.add(alias);
    }
    if(p.netId===null||p.attributes.filter(a=>a.nativeType===8&&a.kindCode===41).length!==1)throw new Error('Result has invalid or ambiguous native NET_ID values; use normalize_net_ids to repair older drawings first');
    const key=nativeGdfIdentityKey(p);
    if(key!==null&&native.has(key))throw new Error('Result has duplicate native NET_ID values among logical instances; use normalize_net_ids to repair older drawings first');
    if(key!==null)native.add(key);
    if(isGdfIo(p)){
      const port=p.nodeName?.toUpperCase();
      if(port&&ports.has(port))throw new Error('Duplicate I/O node name in the resulting drawing');
      if(port)ports.add(port);
    }
  }
}
