import fs from 'node:fs';
import {TOOLS} from '../server.mjs';
const names=new Set(TOOLS.map(t=>t.name));
if(names.size!==TOOLS.length)throw new Error('Duplicate tool names');
const lines=['# MCP tools','',`Version 0.10.1 exposes ${TOOLS.length} tools through tools/list.`,
 '', 'Descriptions and parameters below are generated from the same definitions used by the server.',
 'Inspect the live schema for complete constraints. Paths are scoped to the selected workspace or project.', ''];
for(const tool of TOOLS){
 lines.push(`## ${tool.name}`,'',tool.description,'','| Parameter | Required | Type | Description |','| --- | --- | --- | --- |');
 for(const [name,property] of Object.entries(tool.inputSchema.properties??{})){
  const clean=value=>String(value??'').replaceAll('|','\\|').replaceAll('\n',' ');
  lines.push(`| ${clean(name)} | ${tool.inputSchema.required?.includes(name)?'yes':'no'} | ${clean(Array.isArray(property.type)?property.type.join(' / '):property.type??'schema')} | ${clean(property.description)} |`);
 }
 lines.push('');
}
fs.writeFileSync(new URL('../docs/TOOLS.md',import.meta.url),lines.join('\n')+'\n');
console.log(`Generated documentation for ${TOOLS.length} tools.`);
