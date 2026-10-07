/** Strict MAX+plus II GDF/SYM reader. Coordinates are signed little-endian shorts.
 * The 14-byte header and opcode framing are independently checked against vendor
 * records and controlled original-editor files. Unknown field semantics remain
 * explicit; an exact byte round trip alone is not a semantic proof.
 */
import {parameterSummary,parameterTemplate,MCP_INSTANCE_NAME_PREFIX} from './gdf-properties.mjs';
import {nativeGdfNetId} from './gdf-identities.mjs';
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_TOKENS = 1000000;
const SUPPORTED_MAGIC = new Set(['GDF', 'SYM']);

function reader(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('GDF geometry requires a Buffer');
  if (buffer.length > MAX_BYTES) throw new Error('GDF exceeds the 16 MiB parsing limit');
  if (buffer.length < 9) throw new Error('GDF header is truncated (expected 8-byte header and stream prefix)');
  const magic = buffer.subarray(0, 3).toString('ascii').toUpperCase();
  if (!SUPPORTED_MAGIC.has(magic) || buffer.subarray(3, 6).some(v => v !== 0)) throw new Error('Unsupported GDF/SYM magic');
  const version = buffer.readUInt16LE(6);
  if (version < 2 || version > 6) throw new Error(`Unsupported GDF/SYM version ${version}; modern record grammar covers versions 2 through 6`);
  if (buffer[8] !== 0) throw new Error('Unsupported GDF stream prefix');
  if (buffer.length < 14) throw new Error('Truncated GDF source metadata');
  if (buffer[9] !== 0x65 || buffer[10] !== 3) throw new Error('GDF requires source metadata e with marker 3');
  const metadata = { marker: buffer[10], sourceType: buffer[11], sourceId: buffer[12], sheetCode: String.fromCharCode(buffer[13]) };
  let offset = 14;
  const prefixSize = offset;
  const tokens = [];
  function need(at, length, description) {
    if (!Number.isInteger(length) || length < 0 || at < 0 || at + length > buffer.length) {
      throw new Error(`Truncated GDF ${description} at byte ${at}`);
    }
  }
  function string(at) {
    need(at, 2, 'text prefix');
    const opcode = String.fromCharCode(buffer[at]);
    if (!['s', 'v'].includes(opcode)) throw new Error(`Expected GDF text opcode at byte ${at}`);
    const prefix = opcode === 'v' ? 3 : 2;
    need(at, prefix, 'text length');
    const length = opcode === 'v' ? buffer.readUInt16LE(at + 1) : buffer[at + 1];
    need(at + prefix, length + 1, 'text payload');
    if (buffer[at + prefix + length] !== 0) throw new Error(`GDF text lacks NUL terminator at byte ${at}`);
    return { opcode, offset: at, lengthOffset: at + 1, lengthType: opcode === 'v' ? 'u16' : 'u8', payloadOffset: at + prefix, length, text: buffer.subarray(at + prefix, at + prefix + length).toString('latin1'), end: at + prefix + length + 1 };
  }
  function shorts(at, count, description) {
    need(at, count * 2, description);
    return Array.from({ length: count }, (_, i) => buffer.readInt16LE(at + i * 2));
  }
  let terminal = false; let textContext = 7; let firstLineText = false;
  while (offset < buffer.length) {
    if (tokens.length >= MAX_TOKENS) throw new Error('GDF exceeds the token parsing limit');
    const start = offset;
    const opcode = String.fromCharCode(buffer[offset]);
    let end = offset + 1;
    const token = { id: `record:${offset}`, opcode, offset };
    if (['f', 'g', 'h', 'i', 'u', 't'].includes(opcode)) {
      if (opcode === 'f') textContext = 7;
      if (opcode === 'h') textContext = 8;
      if (opcode === 'i') { textContext = 11; firstLineText = true; }
      if (opcode === 'u') textContext = 10;
      if (opcode === 't') {
        if (end !== buffer.length) throw new Error(`Unexpected GDF trailer after terminal at byte ${offset}`);
        terminal = true;
      }
    } else if (['j', 'p'].includes(opcode)) {
      token.values = shorts(offset + 1, 2, opcode); end = offset + 5;
      if (opcode === 'j') token.values = [buffer.readUInt16LE(offset + 1), buffer.readUInt16LE(offset + 3)];
    } else if (['k', 'l', 'm'].includes(opcode)) {
      token.values = shorts(offset + 1, 4, opcode); need(offset + 9, 2, 'line flags');
      token.flags = buffer.readUInt16LE(offset + 9); end = offset + 11;
      if (opcode === 'k' && token.values[1] !== token.values[3]) throw new Error(`Non-horizontal GDF k wire at byte ${offset}`);
      if (opcode === 'l' && token.values[0] !== token.values[2]) throw new Error(`Non-vertical GDF l wire at byte ${offset}`);
      textContext = 7;
    } else if (opcode === 'n') {
      textContext = 7;
      token.values = shorts(offset + 1, 9, 'arc'); need(offset + 19, 2, 'arc flags');
      for (let i = 6; i < 9; i++) token.values[i] = buffer.readUInt16LE(offset + 1 + i * 2);
      token.flags = buffer.readUInt16LE(offset + 19); end = offset + 21;
    } else if (opcode === 'o') {
      textContext = 7;
      token.values = shorts(offset + 1, 3, 'circle'); need(offset + 7, 2, 'circle flags');
      token.values[2] = buffer.readUInt16LE(offset + 5);
      token.flags = buffer.readUInt16LE(offset + 7); end = offset + 9;
    } else if (opcode === 'r') {
      token.values = shorts(offset + 1, 2, 'placement'); need(offset + 5, 1, 'placement transform');
      token.transform = buffer[offset + 5]; end = offset + 6; textContext = 12;
    } else if (opcode === 'q') {
      need(offset + 1, 8, 'attribute prefix');
      token.attrType = buffer[offset + 1]; token.fontCode = buffer[offset + 2]; token.nativeType = textContext;
      // FUN_1001804d / FUN_10017fd9: subsequent non-NODE_NAME texts in
      // an i q* span are root graphics, while type-6 texts stay line-owned.
      if(textContext===11){token.lineTextContext=true;if(!firstLineText&&token.attrType!==6)token.nativeType=7;firstLineText=false;}
      token.kind = buffer.readUInt16LE(offset + 1);
      token.values = shorts(offset + 3, 2, 'attribute position');
      token.flags = buffer.readUInt16LE(offset + 7);
      end = offset + 9;
      if (token.fontCode >= 4) {
        const font = string(end); token.font = font.text; token.fontOffset = font.offset; end = font.end;
        token.metrics = shorts(end, 2, 'font metrics'); end += 4;
      } else if ([7, 10].includes(textContext) && [0x32, 0x37].includes(token.attrType)) {
        token.metrics = shorts(end, 2, 'text metrics'); end += 4;
      }
      const label = string(end); token.text = label.text; token.textOffset = label.offset; token.textRecord = label; end = label.end;
      if ([0x73, 0x76].includes(buffer[end])) {
        const alt = string(end); token.alternative = alt.text; token.alternativeOffset = alt.offset; token.alternativeRecord = alt; end = alt.end;
      }
      if (textContext === 10) { token.parameterOffset = shorts(end, 1, 'parameter offset')[0]; end += 2; }
    } else {
      throw new Error(`Unknown GDF opcode 0x${buffer[offset].toString(16).padStart(2, '0')} at byte ${offset}`);
    }
    token.end = end; token.body = buffer.subarray(start, end);
    tokens.push(token); offset = end;
  }
  if (!terminal) throw new Error('GDF terminal record is missing');
  if (tokens[0]?.opcode !== 'f' || tokens[1]?.opcode !== 'j') throw new Error('GDF must begin with graphical definition f and extent j');
  return { header: { magic, version, size: 8, streamPrefixSize: prefixSize, sheetCode: metadata?.sheetCode ?? null, sourceMetadata: metadata, rawHex: buffer.subarray(0, prefixSize).toString('hex') }, tokens };
}

/** Exposes original byte slices for lossless edits; rejects unknown/truncated input. */
export function tokeniseGdfGeometry(buffer) {
  const parsed = reader(buffer);
  return [{ id: 'record:0', opcode: '@header', offset: 0, end: parsed.header.streamPrefixSize, header: parsed.header, body: buffer.subarray(0, parsed.header.streamPrefixSize) }, ...parsed.tokens];
}

/** Reassembly preserves original bytes, including fields whose meaning is unknown. */
export function rebuildGdfGeometry(tokens) {
  if (!Array.isArray(tokens) || tokens.some(t => !Buffer.isBuffer(t.body))) throw new Error('Expected GDF token byte slices');
  return Buffer.concat(tokens.map(t => t.body));
}

function point(values, at = 0) { return { x: values[at], y: values[at + 1] }; }
/** Original gio_sym_abs_point transform. Arithmetic right shift and grid mask are
 * intentional: odd and negative intermediate values round down, not to zero. */
export function gdfPlacementTransform(position, extent, code, extension = { left: 0, right: 0 }) {
  if (!position || !extent || !Number.isInteger(code) || code < 0 || code > 7) return null;
  const W = extent.width + (extension.right ?? 0) - (extension.left ?? 0);
  const H = extent.height;
  if (![position.x, position.y, W, H].every(Number.isSafeInteger)) return null;
  const A = (Math.floor((W + H) / 2)) & ~7;
  const B = (Math.floor((H - W) / 2)) & ~7;
  const C = (Math.floor((W - H) / 2)) & ~7;
  const { x: X, y: Y } = position;
  return [[1, 0, 0, 1, X, Y], [0, 1, -1, 0, X + A, Y + B], [-1, 0, 0, -1, X + W, Y + H], [0, -1, 1, 0, X + C, Y + A], [1, 0, 0, -1, X, Y + H], [-1, 0, 0, 1, X + W, Y], [0, -1, -1, 0, X + A, Y + A], [0, 1, 1, 0, X + C, Y + B]][code];
}
export function gdfTransformPoint(position, matrix) {
  if (!matrix) return null;
  return { x: matrix[0] * position.x + matrix[2] * position.y + matrix[4], y: matrix[1] * position.x + matrix[3] * position.y + matrix[5] };
}
/** Recovered FUN_100187e2. Extensions reset, while origin adjustments accumulate. */
export function gdfStretchPlacement(position, width, startX, orientation) {
  if (![position.x, position.y, width, startX, orientation].every(Number.isSafeInteger) || width <= 80 || width > 32767 || orientation < 0 || orientation > 7) throw new Error('Unsupported GDF stretch inputs');
  const R = width - 76;
  const E = R & 0x18 ? (R & 0xffe0) + 32 : R & ~7;
  const leftSide = startX < 8, sign = leftSide ? 1 : -1, D = (E >> 1) & ~7;
  const result = { ...position };
  if ([1, 7].includes(orientation)) { result.x += sign * D; result.y -= sign * D; }
  else if ([2, 5].includes(orientation)) result.x += sign * E;
  else if ([3, 6].includes(orientation)) { result.x += sign * D; result.y += sign * D; }
  return { position: result, extension: { left: leftSide ? E : 0, right: leftSide ? 0 : E } };
}
function textWidth(a) {
  const width = a.fontCode >= 4 ? a.metrics?.width : a.text.length * (a.fontCode === 2 ? 12 : [1, 3].includes(a.fontCode) ? 10 : 8);
  return a.nativeType !== 8 && a.fontCode < 4 ? (width + 10) & ~7 : width;
}
function attribute(token) {
  return { id: token.id, offset: token.offset, textOffset: token.textOffset, textRecord: token.textRecord, alternativeRecord: token.alternativeRecord ?? null, kind: token.kind, kindCode: token.attrType, fontCode: token.fontCode, nativeType: token.nativeType, position: point(token.values), coordinateOffsets: { x: token.offset + 3, y: token.offset + 5 }, text: token.text, alternative: token.alternative ?? null, parameterOffset: token.parameterOffset ?? null, font: token.font ?? null, metrics: token.metrics ? { width: token.metrics[0], height: token.metrics[1] } : null, rawFlags: token.flags, display: { editable: Boolean(token.flags & 1), color: (token.flags >>> 1) & 15, visible: Boolean(token.flags & 32), zoom: Boolean(token.flags & 64), orientation: (token.flags >>> 7) & 7 }, textEncoding: 'byte-preserving-latin1' };
}
function primitive(token) {
  const base = { id: token.id, offset: token.offset, opcode: token.opcode, nativeType: { k: 2, l: 3, m: 4, n: 5, o: 6 }[token.opcode], rawFlags: token.flags };
  if (['k', 'l', 'm'].includes(token.opcode)) {
    return { ...base, kind: 'line', orientation: token.values[1] === token.values[3] ? 'horizontal' : token.values[0] === token.values[2] ? 'vertical' : 'diagonal', start: point(token.values), end: point(token.values, 2), coordinateOffsets: { x1: token.offset + 1, y1: token.offset + 3, x2: token.offset + 5, y2: token.offset + 7 }, endpointDots: [Boolean(token.flags & 1), Boolean(token.flags & 2)], style: (token.flags >>> 2) & 7, thick: Boolean(token.flags & 32), knownFlags: token.flags & 63, electricalRole: 'undetermined' };
  }
  if (token.opcode === 'o') return { ...base, kind: 'circle', center: point(token.values), radius: token.values[2], filled: Boolean(token.flags & 1), knownFlags: token.flags & 1 };
  return { ...base, kind: 'arc', center: point(token.values), start: point(token.values, 2), end: point(token.values, 4), radius: token.values[6], startAngleDegrees: token.values[7], sweepAngleDegrees: token.values[8], endpointDots: [Boolean(token.flags & 16), Boolean(token.flags & 32)], radiusSemantics: 'original-reader-field-some-cached-endpoints-do-not-match' };
}

/** Returns original sheet geometry, reusable symbol definitions and placements. */
export function parseGdfGeometry(buffer) {
  const { header, tokens } = reader(buffer);
  const definitions = []; let current = null; let instance = null; let previousAttribute = null; let phase = 0; let previousToken = null; let annotationOwner = null;
  for (const token of tokens) {
    if (token.opcode === 'f') {
      if (current) throw new Error(`Nested GDF definition at byte ${token.offset}`);
      current = { id: `definition:${token.offset}`, offset: token.offset, extent: null, primitives: [], attributes: [], pins: [], instances: [], markers: [], extraText: [] };
      definitions.push(current); instance = null; previousAttribute = null; phase = 0; annotationOwner = null;
    } else if (token.opcode === 'g' || token.opcode === 't') {
      if (!current || !current.extent) throw new Error(`GDF definition terminator outside definition or missing extent at byte ${token.offset}`);
      current = null; instance = null; previousAttribute = null; annotationOwner = null;
    } else {
      if (!current) throw new Error(`GDF record outside definition at byte ${token.offset}`);
      if (token.opcode === 'j') {
        if (current.extent || instance || phase !== 0) throw new Error(`Misplaced or duplicate GDF extent at byte ${token.offset}`);
        current.extent = { width: token.values[0], height: token.values[1] };
      } else if (token.opcode === 'r') {
        if (definitions.length === 1) throw new Error(`GDF placement lacks a reusable symbol group at byte ${token.offset}`);
        const matrix = gdfPlacementTransform(point(token.values), current.extent, token.transform);
        instance = { id: `instance:${token.offset}`, offset: token.offset, definitionId: current.id, position: point(token.values), coordinateOffsets: { x: token.offset + 1, y: token.offset + 3, orientation: token.offset + 5 }, transform: { code: token.transform, understood: matrix !== null, matrix, extension: { left: 0, right: 0, source: 'default-no-stretch' } }, attributes: [], extraText: [], markers: [], pins: [] };
        current.instances.push(instance); previousAttribute = null;
      } else if (token.opcode === 'q') {
        if (instance && ![8, 10].includes(token.nativeType)) throw new Error(`GDF placement text lacks h/u marker at byte ${token.offset}`);
        if (!instance && token.nativeType === 7 && !token.lineTextContext) phase = 7;
        previousAttribute = attribute(token);
        if (token.nativeType === 11) {
          if (!annotationOwner) throw new Error(`GDF line annotation lacks a line at byte ${token.offset}`);
          previousAttribute.ownerId = annotationOwner.id; previousAttribute.scope = 'line-annotation';
          (annotationOwner.annotations ??= []).push(previousAttribute);
        } else {
          previousAttribute.scope = token.nativeType === 10 ? 'instance-parameter' : token.nativeType === 8 ? 'instance-attribute' : 'graphical-attribute';
          (instance?.attributes ?? current.attributes).push(previousAttribute);
        }
      } else if (token.opcode === 'p') {
        if (instance) throw new Error(`GDF pin definition after placement at byte ${token.offset}`);
        if (!previousAttribute || previousAttribute.nativeType !== 7) throw new Error(`GDF pin lacks preceding graphical attribute at byte ${token.offset}`);
        current.pins.push({ id: `pin:${token.offset}`, offset: token.offset, position: point(token.values), name: previousAttribute.text, direction: 'undetermined', nativeAttributeType: previousAttribute.kindCode, attributeId: previousAttribute.id });
        previousAttribute = null;
      } else if (['k', 'l', 'm', 'n', 'o'].includes(token.opcode)) {
        if (instance) throw new Error(`GDF primitive after placement at byte ${token.offset}`);
        const nextPhase = { k: 2, l: 3, m: 4, n: 5, o: 6 }[token.opcode];
        if (nextPhase < phase) throw new Error(`GDF geometry is out of original-reader order at byte ${token.offset}`);
        phase = nextPhase;
        current.primitives.push(primitive(token)); previousAttribute = null; annotationOwner = null;
      } else if (['h', 'i', 'u'].includes(token.opcode)) {
        if (token.opcode === 'i') {
          if (!previousToken || !['k', 'l'].includes(previousToken.opcode)) throw new Error(`GDF annotation marker lacks preceding wire at byte ${token.offset}`);
          annotationOwner = current.primitives.at(-1);
        } else if (!instance && header.magic !== 'SYM') throw new Error(`GDF instance marker lacks a placement at byte ${token.offset}`);
        (instance?.markers ?? current.markers).push({ id: token.id, opcode: token.opcode, offset: token.offset }); previousAttribute = null;
      } else {
        (instance?.extraText ?? current.extraText).push({ id: token.id, offset: token.offset, text: token.text, association: 'undetermined-expression-or-alias' }); previousAttribute = null;
      }
    }
    previousToken = token;
  }
  const root = definitions[0];
  for (const line of root.primitives.filter(p => p.kind === 'line')) line.electricalRole = header.magic === 'SYM' ? 'symbol-graphic' : line.opcode === 'm' ? 'drawing-line' : line.thick ? 'bus-wire' : 'scalar-wire';
  const placements = [];
  for (const definition of definitions.slice(1)) {
    definition.name = definition.attributes.find(a => [1, 0x13].includes(a.kindCode))?.text ?? null;
    definition.parameterTemplate=parameterTemplate(definition.attributes);
    for (const placement of definition.instances) {
      placement.symbolName = definition.name;
      const idText=placement.attributes.find(a=>a.nativeType===8&&a.kindCode===41)?.text??null;
      placement.netIdText=idText;placement.netId=nativeGdfNetId(idText);
      const nameTag=placement.attributes.find(a=>a.kindCode===0&&a.nativeType===8&&a.text.startsWith(MCP_INSTANCE_NAME_PREFIX));
      placement.instanceName=nameTag?nameTag.text.slice(MCP_INSTANCE_NAME_PREFIX.length):idText;
      placement.instanceNameSource=nameTag?'hidden-DOC-alias':'native-NET_ID';
      placement.nodeName = placement.attributes.find(a => a.kindCode === 5)?.text ?? null;
      placement.parameters=parameterSummary(placement.attributes);
      let effectivePosition = { ...placement.position }, extension = { left: 0, right: 0 }, understood = placement.transform.understood;
      const triggers = [];
      for (const a of [...definition.attributes, ...placement.attributes].filter(a => a.kindCode === 5)) {
        const width = textWidth(a);
        if (width > 80) {
          if (!Number.isSafeInteger(width) || width > 32767 || !understood) { understood = false; break; }
          const definitionText = definition.attributes.includes(a);
          const stretched = gdfStretchPlacement(definitionText ? placement.position : effectivePosition, width, a.position.x, placement.transform.code);
          extension = stretched.extension;
          // r overwrites the origin adjusted while the definition was read.
          if (!definitionText) effectivePosition = stretched.position;
          triggers.push({ attributeId: a.id, textWidth: width });
        }
      }
      placement.effectivePosition = effectivePosition;
      placement.transform.extension = { ...extension, source: triggers.length ? 'decoded-text-driven-stretch' : 'default-no-stretch', triggers };
      placement.transform.matrix = understood ? gdfPlacementTransform(effectivePosition, definition.extent, placement.transform.code, extension) : null;
      placement.transform.understood = placement.transform.matrix !== null;
      placement.pins = definition.pins.map(p => ({ ...p, id: `${placement.id}/${p.id}`, definitionPinId: p.id, localPosition: p.position, worldPosition: gdfTransformPoint(p.position, placement.transform.matrix) }));
      placements.push(placement);
    }
  }
  const allPrimitives = definitions.flatMap(d => d.primitives);
  const attributeCount = tokens.filter(t => t.opcode === 'q').length;
  return {
    format: `MAX+PLUS II ${header.magic === 'GDF' ? 'Graphic Design' : 'Symbol'} File`, header, fileSize: buffer.length, tokenCount: tokens.length,
    coordinateSystem: { units: 'editor-grid-units', origin: 'bottom-left', yAxis: 'up', coordinates: 'signed-16-bit-little-endian' },
    sheet: { id: root.id, extent: root.extent, primitives: root.primitives, wires: header.magic === 'GDF' ? root.primitives.filter(p => p.electricalRole === 'scalar-wire') : [], buses: header.magic === 'GDF' ? root.primitives.filter(p => p.electricalRole === 'bus-wire') : [], drawingLines: root.primitives.filter(p => p.electricalRole === 'drawing-line'), attributes: root.attributes, pins: root.pins, markers: root.markers, extraText: root.extraText },
    definitions: definitions.slice(1), placements,
    counts: { definitions: definitions.length - 1, placements: placements.length, lines: allPrimitives.filter(p => p.kind === 'line').length, circles: allPrimitives.filter(p => p.kind === 'circle').length, arcs: allPrimitives.filter(p => p.kind === 'arc').length, attributes: attributeCount, pins: definitions.reduce((n, d) => n + d.pins.length, 0), sheetPrimitives: root.primitives.length },
    understood: { framing: true, text: true, geometryCoordinates: true, symbolDefinitions: true, translation: true, orientationCodes: [0, 1, 2, 3, 4, 5, 6, 7], allPlacements: placements.every(p => p.transform.understood), electricalRoles: true, connectivity: false, writable: header.magic === 'GDF' && header.version === 6 },
    limitations: ['Geometric coincidence alone does not prove electrical connectivity; pin attribute types do not determine all logical directions.', 'Text-driven symbol stretching is decoded; unsupported orientations/oversized metrics omit world coordinates. Text anchors remain local; rendered glyph bounds are not decoded.', 'Arc fields are preserved; some vendor cached endpoints do not agree with the original radius field.', 'Geometry retains byte values as Latin-1; use gdf_text_format_inspect/edit for explicit Windows-936 decoding and native font authoring. The file has no code-page marker.', 'Writing requires version 6: gdf_construct supports modern instance parameter maps and explicit named wires/bus members. Native CONSTANT/PARAM pairs have separate gdf_declarations_edit support; other legacy/ambiguous forms remain unsupported. Use gdf_connections for source scalar/explicit bit topology and gdf_move_connected for checked scalar movement; macro internals and bus routing remain partial. Numeric NET_ID is distinct from the hidden friendly instance alias.'],
  };
}
