/** Narrow, lossless edits to independently decoded MAX+plus II GDF geometry.
 * Edits address byte offsets in the ORIGINAL buffer. All validation is completed
 * before a result is returned; the input buffer and unrelated records are never
 * mutated. Shared symbol definitions and logical node/parameter text are denied.
 */
import { parseGdfGeometry, tokeniseGdfGeometry } from './gdf-geometry.mjs';

const MAX_EDITS = 10000;
const MAX_TEXT_BYTES = 2047;
const OP_FIELDS = {
  translate: ['recordOffset', 'operation', 'dx', 'dy'],
  set_orientation: ['recordOffset', 'operation', 'orientation'],
  set_line: ['recordOffset', 'operation', 'x1', 'y1', 'x2', 'y2'],
  set_text: ['recordOffset', 'operation', 'text'],
};

function integer(value, name, minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
function short(value, name) { return integer(value, name, -32768, 32767); }
function validateEdit(edit) {
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) throw new Error('Each GDF edit must be an object');
  const fields = OP_FIELDS[edit.operation];
  if (!fields) throw new Error(`Unsupported GDF edit operation ${String(edit.operation)}`);
  for (const key of Object.keys(edit)) if (!fields.includes(key)) throw new Error(`Unexpected field ${key} for ${edit.operation}`);
  for (const key of fields) if (!Object.hasOwn(edit, key)) throw new Error(`Missing field ${key} for ${edit.operation}`);
  integer(edit.recordOffset, 'recordOffset', 0);
}
function coordinates(token) {
  if (['k', 'l', 'm'].includes(token.opcode)) return [1, 3, 5, 7];
  if (token.opcode === 'n') return [1, 3, 5, 7, 9, 11];
  if (['o', 'r'].includes(token.opcode)) return [1, 3];
  if (token.opcode === 'q') return [3, 5];
  throw new Error(`Record ${token.offset} has no editable coordinates`);
}
function describeCoordinates(token, body = token.body) {
  return coordinates(token).map(offset => body.readInt16LE(offset));
}
function translated(token, dx, dy) {
  const body = Buffer.from(token.body);
  const fields = coordinates(token);
  // Validate all coordinates before writing even to our private copy.
  const values = fields.map((offset, index) => short(token.body.readInt16LE(offset) + (index % 2 ? dy : dx), `translated coordinate at byte ${token.offset + offset}`));
  fields.forEach((offset, index) => body.writeInt16LE(values[index], offset));
  return body;
}
function editedText(token, attribute, text) {
  if (typeof text !== 'string' || text.length > MAX_TEXT_BYTES || /[\u0000-\u001f\u007f-\u009f\u0100-\uffff]/u.test(text)) {
    throw new Error(`text must contain at most ${MAX_TEXT_BYTES} byte-preserving Latin-1 characters without NUL or controls`);
  }
  const record = attribute.textRecord;
  const maximum = record.lengthType === 'u8' ? 255 : 65535;
  if (text.length > maximum) throw new Error(`GDF ${record.lengthType} text length exceeds ${maximum}`);
  const prefix = Buffer.from(token.body.subarray(0, record.payloadOffset - token.offset));
  const relativeLengthOffset = record.lengthOffset - token.offset;
  if (record.lengthType === 'u8') prefix.writeUInt8(text.length, relativeLengthOffset);
  else if (record.lengthType === 'u16') prefix.writeUInt16LE(text.length, relativeLengthOffset);
  else throw new Error('Unsupported GDF text length type');
  // Preserve NUL, font, metrics, alternative string and every trailing byte.
  return Buffer.concat([prefix, Buffer.from(text, 'latin1'), token.body.subarray(record.payloadOffset + record.length - token.offset)]);
}

/**
 * Operations: translate {dx,dy}; set_orientation {orientation:0..7};
 * set_line {x1,y1,x2,y2}; set_text {text}. Every operation additionally requires
 * recordOffset, as returned by a fresh geometry observation. File-level hash,
 * preview, backup and atomic replacement belong to the workspace wrapper.
 */
export function editGdfGeometry(buffer, edits) {
  const parsed = parseGdfGeometry(buffer);
  if (parsed.header.magic !== 'GDF' || parsed.header.version !== 6) throw new Error('Geometry editing supports MAX+plus II GDF version 6 only');
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > MAX_EDITS) throw new Error(`edits must be an array with 1 through ${MAX_EDITS} entries`);
  const tokens = tokeniseGdfGeometry(buffer);
  const tokenMap = new Map(tokens.map(token => [token.offset, token]));
  const primitives = new Map(parsed.sheet.primitives.map(item => [item.offset, item]));
  const placements = new Map(parsed.placements.map(item => [item.offset, item]));
  const annotations = new Map(parsed.sheet.attributes.filter(item => item.kindCode === 0 && item.nativeType === 7).map(item => [item.offset, item]));
  const seen = new Set();
  const replacements = new Map();
  const changes = [];
  for (const edit of edits) {
    validateEdit(edit);
    const token = tokenMap.get(edit.recordOffset);
    if (!token) throw new Error(`Unknown GDF recordOffset ${edit.recordOffset}`);
    if (seen.has(edit.recordOffset)) throw new Error(`Duplicate GDF recordOffset ${edit.recordOffset}; combine changes in a new observation`);
    seen.add(edit.recordOffset);
    const primitive = primitives.get(edit.recordOffset);
    const placement = placements.get(edit.recordOffset);
    const annotation = annotations.get(edit.recordOffset);
    let body; let before; let after;
    if (edit.operation === 'translate') {
      integer(edit.dx, 'dx'); integer(edit.dy, 'dy');
      if (!primitive && !placement && !annotation) throw new Error('translate only supports root sheet primitives, symbol placements and free sheet annotations');
      body = translated(token, edit.dx, edit.dy);
      before = describeCoordinates(token); after = describeCoordinates(token, body);
    } else if (edit.operation === 'set_orientation') {
      integer(edit.orientation, 'orientation', 0, 7);
      if (!placement) throw new Error('set_orientation only supports symbol placements');
      body = Buffer.from(token.body);
      before = token.transform; after = edit.orientation;
      body[placement.coordinateOffsets.orientation - token.offset] = edit.orientation;
    } else if (edit.operation === 'set_line') {
      if (!primitive || primitive.kind !== 'line') throw new Error('set_line only supports root sheet lines and wires');
      const values = ['x1', 'y1', 'x2', 'y2'].map(key => short(edit[key], key));
      if (token.opcode === 'k' && edit.y1 !== edit.y2) throw new Error('A k wire must remain horizontal; changing its opcode is unsupported');
      if (token.opcode === 'l' && edit.x1 !== edit.x2) throw new Error('An l wire must remain vertical; changing its opcode is unsupported');
      body = Buffer.from(token.body);
      coordinates(token).forEach((offset, index) => body.writeInt16LE(values[index], offset));
      before = describeCoordinates(token); after = values;
    } else {
      if (!annotation) throw new Error('set_text only supports free root sheet annotations (kindCode 0); symbol names, nodes, pins and parameters are unsupported');
      body = editedText(token, annotation, edit.text);
      before = annotation.text; after = edit.text;
    }
    replacements.set(token.offset, body);
    changes.push({ recordOffset: token.offset, operation: edit.operation, target: placement ? 'symbol-placement' : annotation ? 'free-sheet-annotation' : primitive.electricalRole ?? primitive.kind, before, after, previousBytes: token.body.length, resultingBytes: body.length });
  }
  const result = Buffer.concat(tokens.map(token => replacements.get(token.offset) ?? token.body));
  const checked = parseGdfGeometry(result);
  if (checked.tokenCount !== parsed.tokenCount || JSON.stringify(checked.counts) !== JSON.stringify(parsed.counts)) throw new Error('GDF edit changed the record structure unexpectedly');
  return {
    buffer: result, changes,
    note: 'Only explicitly selected geometry/text fields changed. Shared symbol definitions, unknown flags, fonts and unrelated bytes are retained. Wires are not moved automatically with a placement; connectivity must be checked and the project recompiled. Free-text font metrics remain the original stored values. Original record offsets may change after text length edits; observe the resulting file again before another edit.',
  };
}
