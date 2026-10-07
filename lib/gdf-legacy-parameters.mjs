/** Original CONSTANT/PARAM declaration symbols use h attributes (native type 8),
 * not u instance-property records. Only their unambiguous existing name/value
 * pairs are edited; other legacy u forms and source expressions stay opaque. */
import {parseGdfGeometry,tokeniseGdfGeometry} from './gdf-geometry.mjs';
import {replaceGdfLabel,gdfString} from './gdf-properties.mjs';

const DECLARATIONS={CONSTANT:{name:51,value:52,kind:'constant'},PARAM:{name:53,value:54,kind:'parameter-default'}};
const code=a=>a.kindCode??a.attrType;

export function legacyGdfDeclarationSummary(placement){
  const declaration=DECLARATIONS[placement.symbolName?.toUpperCase()],records=placement.attributes.filter(a=>[51,52,53,54].includes(code(a)));
  if(!declaration&&!records.length)return null;
  const name=records.filter(a=>a.nativeType===8&&code(a)===declaration?.name),value=records.filter(a=>a.nativeType===8&&code(a)===declaration?.value);
  const writable=Boolean(declaration&&records.length===2&&name.length===1&&value.length===1&&!records.some(a=>a.alternative!==null&&a.alternative!==undefined)&&!placement.attributes.some(a=>a.nativeType===10));
  return {recordOffset:placement.offset,symbolName:placement.symbolName,declarationKind:declaration?.kind??null,format:writable?'native-h-declaration-pair':'unsupported-legacy-or-ambiguous',writable,name:name[0]?.text??null,value:value[0]?.text??null,nameRecordOffset:name[0]?.offset??null,valueRecordOffset:value[0]?.offset??null,recordOffsets:records.map(a=>a.offset),note:'These are source-level CONSTANT/PARAM declarations, not assignments on an arbitrary logic instance. PARAM value is the declaration default. Expressions and dependency semantics require the original compiler.'};
}

export function readGdfLegacyDeclarations(buffer){
  const parsed=parseGdfGeometry(buffer);
  return parsed.placements.map(legacyGdfDeclarationSummary).filter(Boolean);
}

function validateAssignment(edit){
  if(!edit||typeof edit!=='object'||Array.isArray(edit)||Object.keys(edit).some(k=>!['recordOffset','name','value'].includes(k)))throw new Error('Legacy declaration edit requires only recordOffset, name and value');
  if(!Number.isSafeInteger(edit.recordOffset)||edit.recordOffset<0)throw new Error('recordOffset must refer to an original declaration placement');
  if(typeof edit.name!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(edit.name))throw new Error('Legacy declaration name must be an identifier of at most 128 bytes');
  if(typeof edit.value!=='string'&&!Number.isSafeInteger(edit.value))throw new Error('Legacy declaration value must be a source expression string or safe integer');
  const value=String(edit.value).trim();if(!value||value.length>256||/[\r\n]/.test(value))throw new Error('Legacy declaration value must be a nonempty single-line source expression up to 256 bytes');gdfString(value);
  return {name:edit.name,value};
}

/** Labels use original offsets so a caller can merge this plan into a mixed
 * construction transaction without applying edits sequentially and rebasing. */
export function planLegacyGdfDeclarationEdit(placement,edit){
  const next=validateAssignment(edit),summary=placement?legacyGdfDeclarationSummary(placement):null;
  if(!summary?.writable||placement.offset!==edit.recordOffset)throw new Error('Legacy editing requires one existing unambiguous CONSTANT h/51/52 or PARAM h/53/54 declaration pair; u properties and ambiguous records are preserved');
  return {labels:[{recordOffset:summary.nameRecordOffset,text:next.name},{recordOffset:summary.valueRecordOffset,text:next.value}],change:{recordOffset:edit.recordOffset,symbolName:summary.symbolName,declarationKind:summary.declarationKind,before:{name:summary.name,value:summary.value},after:next}};
}

export function editGdfLegacyDeclarations(buffer,edits){
  const before=parseGdfGeometry(buffer);
  if(before.header.magic!=='GDF'||before.header.version!==6)throw new Error('Legacy declaration editing supports modern GDF version 6 only');
  if(!Array.isArray(edits)||!edits.length||edits.length>100)throw new Error('Legacy declaration edits must contain 1 through 100 entries');
  const tokens=tokeniseGdfGeometry(buffer),replacements=new Map(),touched=new Set(),changes=[];
  for(const edit of edits){
    const plan=planLegacyGdfDeclarationEdit(before.placements.find(p=>p.offset===edit?.recordOffset),edit);if(touched.has(edit.recordOffset))throw new Error('A declaration placement may be changed only once per transaction');touched.add(edit.recordOffset);
    for(const {recordOffset,text} of plan.labels){
      const token=tokens.find(t=>t.offset===recordOffset);if(token.text!==text)replacements.set(recordOffset,replaceGdfLabel(token,text));
    }
    changes.push(plan.change);
  }
  const result=Buffer.concat(tokens.map(t=>replacements.get(t.offset)??t.body)),after=parseGdfGeometry(result),actual=tokeniseGdfGeometry(result);
  if(actual.length!==tokens.length||actual.some((t,i)=>t.opcode!==tokens[i].opcode||t.nativeType!==tokens[i].nativeType))throw new Error('Legacy declaration editing would change original record ownership');
  return {buffer:result,changes,counts:{before:before.counts,after:after.counts},note:'Changed only the two original declaration label strings. Drawing geometry, native IDs, friendly aliases, other declarations, font flags/metrics and all u property blocks are preserved. Re-read offsets and use the original compiler/simulator to verify expressions, scopes, defaults and dependencies.'};
}
