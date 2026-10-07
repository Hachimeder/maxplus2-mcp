/** Small dependency-free validator for the JSON Schema subset used by tools. */
export function validateArguments(value, schema, where = 'arguments') {
  const fail = message => { throw new Error(`${where}: ${message}`); };
  if (schema.anyOf) {
    if (!schema.anyOf.some(option => { try { validateArguments(value, option, where); return true; } catch { return false; } })) fail('does not match any allowed shape');
  }
  const types = { object: v => v !== null && typeof v === 'object' && !Array.isArray(v), array: Array.isArray, string:v=>typeof v==='string', boolean:v=>typeof v==='boolean', number:v=>typeof v==='number'&&Number.isFinite(v), integer:v=>Number.isSafeInteger(v), null:v=>v===null };
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(t => types[t]?.(value))) fail(`expected ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`maximum ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) fail(`must exceed ${schema.exclusiveMinimum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail('string too short');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail('string too long');
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail('array too short');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('array too long');
    if (schema.items) value.forEach((v,i)=>validateArguments(v,schema.items,`${where}[${i}]`));
  } else if (value && typeof value === 'object') {
    if(schema.minProperties!==undefined&&Object.keys(value).length<schema.minProperties)fail('object has too few properties');
    if(schema.maxProperties!==undefined&&Object.keys(value).length>schema.maxProperties)fail('object has too many properties');
    for (const key of schema.required ?? []) if (!Object.hasOwn(value,key)) fail(`missing required field ${key}`);
    for (const [key,v] of Object.entries(value)) {
      if (['__proto__','constructor','prototype','__job'].includes(key)) fail(`reserved field ${key}`);
      const spec = schema.properties?.[key];
      if (spec) validateArguments(v,spec,`${where}.${key}`);
      else if (schema.additionalProperties === false) fail(`unknown field ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateArguments(v,schema.additionalProperties,`${where}.${key}`);
    }
  }
}
