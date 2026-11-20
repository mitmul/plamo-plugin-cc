// Validation for tool arguments.
//
// Implements only the JSON Schema keywords this server's tool definitions use:
// type, properties, required, additionalProperties: false, enum, minimum,
// maximum, minLength, maxLength, minItems, maxItems and items.
//
// Models occasionally send "20" for an integer, "true" for a boolean, or one
// string where a list of strings is expected. Those are coerced instead of
// rejected, because bouncing the call back costs a round trip and the intent
// is unambiguous.

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function coerce(schema, value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if ((schema.type === 'integer' || schema.type === 'number') && trimmed !== '' && Number.isFinite(Number(trimmed))) {
    return Number(trimmed);
  }
  if (schema.type === 'boolean' && /^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (schema.type === 'array' && schema.items?.type === 'string') return [value];
  return value;
}

/** Check one value; `path` names it in messages, e.g. `location.city` or `files[0]`. */
function check(schema, rawValue, path, errors) {
  const value = coerce(schema, rawValue);
  const actual = typeOf(value);
  const name = `"${path}"`;

  switch (schema.type) {
    case 'string':
      if (actual !== 'string') {
        errors.push(`${name} must be a string`);
        return value;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(schema.minLength === 1 ? `${name} must not be empty` : `${name} must be at least ${schema.minLength} characters`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(`${name} must be at most ${schema.maxLength} characters`);
      }
      break;
    case 'integer':
    case 'number':
      if (actual !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) {
        errors.push(`${name} must be ${schema.type === 'integer' ? 'an integer' : 'a number'}`);
        return value;
      }
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${name} must be >= ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${name} must be <= ${schema.maximum}`);
      break;
    case 'boolean':
      if (actual !== 'boolean') {
        errors.push(`${name} must be true or false`);
        return value;
      }
      break;
    case 'array':
      if (actual !== 'array') {
        errors.push(`${name} must be an array`);
        return value;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${name} must have at least ${schema.minItems} item(s)`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${name} must have at most ${schema.maxItems} item(s)`);
      return schema.items ? value.map((item, index) => check(schema.items, item, `${path}[${index}]`, errors)) : value;
    case 'object':
      if (actual !== 'object') {
        errors.push(`${name} must be an object`);
        return value;
      }
      return schema.properties ? checkObject(schema, value, path, errors) : value;
    default:
      break;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${name} must be one of: ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`);
  }
  return value;
}

function checkObject(schema, input, path, errors) {
  const prefix = path ? `${path}.` : '';
  const output = {};
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  // Defined rather than assigned, so that a key such as "__proto__" becomes an ordinary property.
  const set = (key, value) => Object.defineProperty(output, key, { value, enumerable: true, writable: true, configurable: true });

  for (const [key, value] of Object.entries(input)) {
    // An explicit null or undefined for an optional parameter means "omitted".
    if (value === null || value === undefined) continue;
    // Only the schema's own entries count: "constructor" or "__proto__" must not find Object.prototype.
    const propertySchema = Object.hasOwn(properties, key) ? properties[key] : null;
    // So does an empty string, which is how a model fills in an optional text parameter it has no use for.
    if (value === '' && propertySchema?.type === 'string' && !required.includes(key)) continue;
    if (propertySchema) {
      set(key, check(propertySchema, value, `${prefix}${key}`, errors));
    } else if (schema.additionalProperties === false) {
      errors.push(`unknown parameter "${prefix}${key}" (allowed: ${Object.keys(properties).join(', ')})`);
    } else {
      set(key, value);
    }
  }

  for (const key of required) {
    if (!Object.hasOwn(output, key)) errors.push(`missing required parameter "${prefix}${key}"`);
  }
  return output;
}

/**
 * Validate and normalise the arguments of a tool call.
 * @param {object} schema  The tool's inputSchema (type: "object").
 * @param {unknown} input  The `arguments` value from tools/call.
 * @returns {{ value: Record<string, any>, errors: string[] }}
 */
export function validateArgs(schema, input) {
  if (input === undefined || input === null) input = {};
  if (typeOf(input) !== 'object') return { value: {}, errors: ['arguments must be an object'] };
  const errors = [];
  const value = checkObject(schema, input, '', errors);
  return { value, errors };
}
