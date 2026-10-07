/** Stored native application preferences are separate from GDF q display bits. */
import fs from 'node:fs';
import path from 'node:path';
import {sha256} from './workspace.mjs';
import {detectInstall} from './runtime.mjs';

export function inspectStoredPalette(text){
  let section=null;const entries=[],seen=new Set();
  for(const [i,line] of String(text).split(/\r?\n/).entries()){
    const header=/^\s*\[([^\]]+)\]\s*$/.exec(line);
    if(header){section=header[1].toLowerCase();continue;}
    if(section!=='colors'||/^\s*[;#]/.test(line)||!line.trim())continue;
    const kv=/^\s*([^=]+?)\s*=\s*(.*?)\s*$/.exec(line);
    if(!kv)throw new Error(`Malformed Colors entry at line${i+1}`);
    const [name,value]=kv.slice(1),key=name.toLowerCase();
    if(seen.has(key))throw new Error(`Duplicate native Colors key: ${name}`);seen.add(key);
    if(entries.length>=100)throw new Error('Native palette exceeds100 entries');
    if(name.length>128||!/^\d+$/.test(value)||Number(value)>18)throw new Error(`Unrecognized native color entry: ${name}`);
    const index=Number(value);entries.push({name,index,line:i+1,verifiedMeaning:index===0?'black':index===2?'blue':index===18?'Windows system text color':null});
  }
  if(!entries.length)throw new Error('No stored [Colors] palette found');
  return {entries,scope:'MAX+plus II application preferences',savedSettingsOnly:true,liveWindowVerified:false,
    roles:{freeDocText:'Text',nativePinNames:'Symbol Pinstub Names',electricalNodes:'Nodes & Connection Dots'},
    limitations:['GDF text color bits do not certify the original editor visible color.','The running editor may have unsaved settings; this result reads stored maxplus2.ini only.','Use desktop_observe and Options / Color Palette / Preview to verify visible colors, then OK to save.','Other indices have no asserted RGB mapping here.']};
}

export function inspectDisplayPalette(explicitRoot){
  if(explicitRoot&&(!fs.existsSync(path.join(explicitRoot,'maxplus2.exe'))))throw new Error('Explicit MAX+plus II installation is missing; provide the correct root');
  const install=detectInstall(explicitRoot);if(!install?.root)throw new Error('MAX+plus II installation not found');
  const file=path.join(fs.realpathSync(install.root),'maxplus2.ini');
  const stat=fs.statSync(file);if(!stat.isFile()||stat.size>512*1024)throw new Error('Expected ordinary maxplus2.ini up to512KiB');
  const bytes=fs.readFileSync(file);
  return {path:file,sha256:sha256(bytes),bytes:bytes.length,...inspectStoredPalette(bytes.toString('latin1'))};
}
