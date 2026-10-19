'use strict';
// A small, strict validator for model output (no dependency). Supports the subset PayProbe's AI schemas use:
//   { type: 'object', properties, required, additionalProperties: false }
//   { type: 'array', items, minItems, maxItems }
//   { type: 'string', minLength, maxLength, enum, pattern }
//   { type: 'integer' | 'number', minimum, maximum }
//   { type: 'boolean' }
// Objects reject unknown keys unless additionalProperties is true. Returns { ok, errors }.

function validate(value, schema, at = '$') {
  const errors = [];
  const fail = (msg) => errors.push(`${at}: ${msg}`);
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { fail('expected object'); break; }
      const props = schema.properties ?? {};
      for (const k of schema.required ?? []) if (!(k in value)) fail(`missing required "${k}"`);
      for (const [k, v] of Object.entries(value)) {
        if (props[k]) errors.push(...validate(v, props[k], `${at}.${k}`).errors);
        else if (schema.additionalProperties !== true) fail(`unexpected property "${k}"`);
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) { fail('expected array'); break; }
      if (schema.minItems !== undefined && value.length < schema.minItems) fail(`expected at least ${schema.minItems} item(s)`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`expected at most ${schema.maxItems} item(s)`);
      value.forEach((v, i) => errors.push(...validate(v, schema.items, `${at}[${i}]`).errors));
      break;
    }
    case 'string': {
      if (typeof value !== 'string') { fail('expected string'); break; }
      if (schema.minLength !== undefined && value.trim().length < schema.minLength) fail(`shorter than ${schema.minLength}`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(`longer than ${schema.maxLength}`);
      if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.join(', ')}`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(`does not match ${schema.pattern}`);
      break;
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) { fail(`expected ${schema.type}`); break; }
      if (schema.minimum !== undefined && value < schema.minimum) fail(`below minimum ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) fail(`above maximum ${schema.maximum}`);
      break;
    }
    case 'boolean':
      if (typeof value !== 'boolean') fail('expected boolean');
      break;
    default:
      fail(`unsupported schema type ${schema.type}`);
  }
  return { ok: errors.length === 0, errors };
}

// Compact description of a schema for prompts (keeps prompts small under the free-tier token budget).
function describe(schema) {
  switch (schema.type) {
    case 'object': return `{${Object.entries(schema.properties ?? {}).map(([k, v]) => `"${k}"${(schema.required ?? []).includes(k) ? '' : '?'}: ${describe(v)}`).join(', ')}}`;
    case 'array': return `[${describe(schema.items)}] (${schema.minItems ?? 0}-${schema.maxItems ?? 'n'} items)`;
    case 'string': return schema.enum ? schema.enum.map((e) => `"${e}"`).join('|') : `string${schema.maxLength ? `<=${schema.maxLength}` : ''}`;
    default: return schema.type;
  }
}

module.exports = { validate, describe };
