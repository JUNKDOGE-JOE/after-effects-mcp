function schemaParts(schema) {
  const value = schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : {};
  const canonical = value.type === 'object' || value.properties || value.required;
  return {
    properties: canonical ? value.properties || {} : value,
    required: new Set(canonical && Array.isArray(value.required) ? value.required : []),
  };
}

export function initialToolArgs(schema) {
  const { properties } = schemaParts(schema);
  return Object.entries(properties).reduce((result, [name, rule]) => {
    if (rule && Object.hasOwn(rule, 'default')) result[name] = rule.default;
    else if (rule && rule.type === 'boolean') result[name] = false;
    else result[name] = '';
    return result;
  }, {});
}

export function toolArgFields(schema) {
  const { properties, required } = schemaParts(schema);
  return Object.entries(properties).map(([name, rawRule]) => {
    const rule = rawRule && typeof rawRule === 'object' ? rawRule : {};
    return {
      name,
      type: rule.type || 'string',
      required: required.has(name),
      enum: Array.isArray(rule.enum) ? rule.enum : null,
      minimum: rule.minimum,
      maximum: rule.maximum,
      supported: ['string', 'number', 'integer', 'boolean'].includes(rule.type || 'string')
        || Array.isArray(rule.enum),
    };
  });
}

export function buildToolArgs(schema, values) {
  const fields = toolArgFields(schema);
  const result = {};
  for (const field of fields) {
    const value = values && values[field.name];
    if ((value === '' || value === undefined) && !field.required) continue;
    if ((value === '' || value === undefined) && field.required) {
      throw new TypeError(`Missing required argument: ${field.name}`);
    }
    if (field.type === 'integer') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) throw new TypeError(`Invalid integer: ${field.name}`);
      result[field.name] = parsed;
    } else if (field.type === 'number') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new TypeError(`Invalid number: ${field.name}`);
      result[field.name] = parsed;
    } else if (field.type === 'boolean') {
      result[field.name] = Boolean(value);
    } else if (field.supported) {
      result[field.name] = value;
    } else {
      throw new TypeError(`Use Advanced JSON for argument: ${field.name}`);
    }
    if (field.enum && !field.enum.some((item) => Object.is(item, result[field.name]))) {
      throw new TypeError(`Invalid enum value: ${field.name}`);
    }
    if (typeof result[field.name] === 'number') {
      if (field.minimum !== undefined && result[field.name] < field.minimum) {
        throw new TypeError(`Value below minimum: ${field.name}`);
      }
      if (field.maximum !== undefined && result[field.name] > field.maximum) {
        throw new TypeError(`Value above maximum: ${field.name}`);
      }
    }
  }
  return result;
}

