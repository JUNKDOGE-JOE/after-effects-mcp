'use strict';

// A deliberately small Draft 2020-12 validator for the generated native
// program contracts. It is not a general-purpose JSON Schema implementation:
// an unrecognized keyword is an implementation error and fails closed.

const SCHEMA_KEYWORDS = Object.freeze([
    '$ref',
    'additionalProperties',
    'allOf',
    'anyOf',
    'const',
    'default',
    'else',
    'enum',
    'if',
    'items',
    'maxItems',
    'maxLength',
    'maximum',
    'minItems',
    'minLength',
    'minimum',
    'not',
    'oneOf',
    'pattern',
    'properties',
    'required',
    'then',
    'type',
]);

const SCHEMA_METADATA = new Set(['$defs', '$id', '$schema']);
const KEYWORD_SET = new Set(SCHEMA_KEYWORDS);

function own(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function pathText(path) {
    let output = '';
    path.forEach(function (part) {
        if (typeof part === 'number') output += '[' + part + ']';
        else output += output ? '.' + part : String(part);
    });
    return output || '$';
}

function error(path, message) {
    return { path: pathText(path), message };
}

function jsonEqual(left, right) {
    if (left === right) return true;
    if (typeof left === 'number' && typeof right === 'number') {
        return Number.isNaN(left) && Number.isNaN(right);
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right)
            && left.length === right.length
            && left.every(function (item, index) { return jsonEqual(item, right[index]); });
    }
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
        && leftKeys.every(function (key) {
            return own(right, key) && jsonEqual(left[key], right[key]);
        });
}

function resolveReference(reference, rootSchema, documents) {
    if (typeof reference !== 'string') {
        throw new Error('JSON Schema $ref must be a string');
    }
    let document = rootSchema;
    let pointer = reference;
    const externalMarker = 'aegp-rpc.schema.json#';
    if (reference.indexOf(externalMarker) === 0) {
        document = documents['aegp-rpc.schema.json'];
        pointer = reference.slice('aegp-rpc.schema.json'.length);
        if (!document) throw new Error('unresolved JSON Schema document: aegp-rpc.schema.json');
    } else if (reference.indexOf('#') !== 0) {
        throw new Error('unsupported JSON Schema $ref: ' + reference);
    } else if ((!rootSchema || !rootSchema.$defs) && documents['aegp-rpc.schema.json']) {
        // Generated primitive result schemas use #/$defs/... while the
        // definitions live in the shared RPC document.
        document = documents['aegp-rpc.schema.json'];
    }
    if (pointer === '#') return document;
    if (pointer.indexOf('#/') !== 0) throw new Error('unsupported JSON Schema $ref: ' + reference);
    return pointer.slice(2).split('/').reduce(function (value, segment) {
        const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
        if (value === null || value === undefined || !own(value, key)) {
            throw new Error('unresolved JSON Schema $ref: ' + reference);
        }
        return value[key];
    }, document);
}

function assertSchemaNode(schema, rootSchema, documents, seen) {
    if (schema === true || schema === false) return;
    if (!isPlainObject(schema)) throw new Error('JSON Schema node must be an object or boolean');
    if (seen.has(schema)) return;
    seen.add(schema);

    Object.keys(schema).forEach(function (key) {
        if (key.indexOf('x-') === 0) return;
        if (!KEYWORD_SET.has(key) && !SCHEMA_METADATA.has(key)) {
            throw new Error('unsupported JSON Schema keyword: ' + key);
        }
    });

    if (own(schema, '$ref')) {
        assertSchemaNode(resolveReference(schema.$ref, rootSchema, documents), rootSchema, documents, seen);
    }
    if (own(schema, '$defs')) {
        if (!isPlainObject(schema.$defs)) throw new Error('$defs must be an object');
        Object.keys(schema.$defs).forEach(function (key) {
            assertSchemaNode(schema.$defs[key], rootSchema, documents, seen);
        });
    }
    if (own(schema, 'properties')) {
        if (!isPlainObject(schema.properties)) throw new Error('properties must be an object');
        Object.keys(schema.properties).forEach(function (key) {
            assertSchemaNode(schema.properties[key], rootSchema, documents, seen);
        });
    }
    if (own(schema, 'additionalProperties') && typeof schema.additionalProperties === 'object') {
        assertSchemaNode(schema.additionalProperties, rootSchema, documents, seen);
    }
    if (own(schema, 'items')) assertSchemaNode(schema.items, rootSchema, documents, seen);
    ['allOf', 'anyOf', 'oneOf'].forEach(function (key) {
        if (!own(schema, key)) return;
        if (!Array.isArray(schema[key])) throw new Error(key + ' must be an array');
        schema[key].forEach(function (item) { assertSchemaNode(item, rootSchema, documents, seen); });
    });
    ['if', 'then', 'else', 'not'].forEach(function (key) {
        if (own(schema, key)) assertSchemaNode(schema[key], rootSchema, documents, seen);
    });
    if (own(schema, 'pattern')) {
        try { new RegExp(schema.pattern, 'u'); } catch (errorValue) {
            throw new Error('invalid JSON Schema pattern: ' + errorValue.message);
        }
    }
}

function typeMatches(type, value) {
    if (type === 'object') return isPlainObject(value);
    if (type === 'array') return Array.isArray(value);
    if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'null') return value === null;
    if (type === 'boolean') return typeof value === 'boolean';
    if (type === 'string') return typeof value === 'string';
    throw new Error('unsupported JSON Schema type: ' + type);
}

function validateNode(schema, value, path, errors, rootSchema, documents) {
    if (schema === true) return;
    if (schema === false) {
        errors.push(error(path, 'must not match the false schema'));
        return;
    }

    if (own(schema, '$ref')) {
        validateNode(resolveReference(schema.$ref, rootSchema, documents), value, path, errors, rootSchema, documents);
    }
    if (own(schema, 'const') && !jsonEqual(schema.const, value)) {
        errors.push(error(path, 'must equal the const value'));
    }
    if (own(schema, 'enum')
        && (!Array.isArray(schema.enum) || !schema.enum.some(function (item) { return jsonEqual(item, value); }))) {
        errors.push(error(path, 'must be one of the enumerated values'));
    }

    if (own(schema, 'not')) {
        const nested = [];
        validateNode(schema.not, value, path, nested, rootSchema, documents);
        if (nested.length === 0) errors.push(error(path, 'must not match the not schema'));
    }
    if (own(schema, 'if')) {
        const condition = [];
        validateNode(schema.if, value, path, condition, rootSchema, documents);
        const branch = condition.length === 0 ? schema.then : schema.else;
        if (branch !== undefined) validateNode(branch, value, path, errors, rootSchema, documents);
    }
    ['allOf', 'anyOf', 'oneOf'].forEach(function (key) {
        if (!own(schema, key)) return;
        const branches = schema[key];
        const branchErrors = branches.map(function (branch) {
            const nested = [];
            validateNode(branch, value, path, nested, rootSchema, documents);
            return nested;
        });
        if (key === 'allOf') {
            branchErrors.forEach(function (nested) { nested.forEach(function (item) { errors.push(item); }); });
        } else if (key === 'anyOf' && !branchErrors.some(function (nested) { return nested.length === 0; })) {
            errors.push(error(path, 'must match at least one schema in anyOf'));
        } else if (key === 'oneOf'
            && branchErrors.filter(function (nested) { return nested.length === 0; }).length !== 1) {
            errors.push(error(path, 'must match exactly one schema in oneOf'));
        }
    });

    if (own(schema, 'type')) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!types.some(function (type) { return typeMatches(type, value); })) {
            errors.push(error(path, 'must be of type ' + types.join(' or ')));
            return;
        }
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        if (own(schema, 'minimum') && value < schema.minimum) {
            errors.push(error(path, 'must be greater than or equal to ' + schema.minimum));
        }
        if (own(schema, 'maximum') && value > schema.maximum) {
            errors.push(error(path, 'must be less than or equal to ' + schema.maximum));
        }
    }
    if (typeof value === 'string') {
        const length = Array.from(value).length;
        if (own(schema, 'minLength') && length < schema.minLength) {
            errors.push(error(path, 'must contain at least ' + schema.minLength + ' characters'));
        }
        if (own(schema, 'maxLength') && length > schema.maxLength) {
            errors.push(error(path, 'must contain at most ' + schema.maxLength + ' characters'));
        }
        if (own(schema, 'pattern') && !(new RegExp(schema.pattern, 'u')).test(value)) {
            errors.push(error(path, 'must match the required pattern'));
        }
    }
    if (Array.isArray(value)) {
        if (own(schema, 'minItems') && value.length < schema.minItems) {
            errors.push(error(path, 'must contain at least ' + schema.minItems + ' items'));
        }
        if (own(schema, 'maxItems') && value.length > schema.maxItems) {
            errors.push(error(path, 'must contain at most ' + schema.maxItems + ' items'));
        }
        if (own(schema, 'items')) {
            value.forEach(function (item, index) {
                validateNode(schema.items, item, path.concat(index), errors, rootSchema, documents);
            });
        }
    }
    if (isPlainObject(value)) {
        if (Array.isArray(schema.required)) {
            schema.required.forEach(function (key) {
                if (!own(value, key)) errors.push(error(path.concat(key), 'is required'));
            });
        }
        const properties = isPlainObject(schema.properties) ? schema.properties : {};
        Object.keys(properties).forEach(function (key) {
            if (own(value, key)) validateNode(properties[key], value[key], path.concat(key), errors, rootSchema, documents);
        });
        if (schema.additionalProperties === false) {
            Object.keys(value).forEach(function (key) {
                if (!own(properties, key)) {
                    errors.push(error(path.concat(key), 'is not allowed by additionalProperties'));
                }
            });
        } else if (isPlainObject(schema.additionalProperties)) {
            Object.keys(value).forEach(function (key) {
                if (!own(properties, key)) {
                    validateNode(schema.additionalProperties, value[key], path.concat(key), errors, rootSchema, documents);
                }
            });
        }
    }
}

function assertSupportedSchema(schema, options) {
    const input = options || {};
    const rootSchema = input.rootSchema || schema;
    const documents = input.documents || {};
    assertSchemaNode(schema, rootSchema, documents, new Set());
    return schema;
}

function createValidator(schema, options) {
    const input = options || {};
    const rootSchema = input.rootSchema || schema;
    const documents = input.documents || {};
    assertSupportedSchema(schema, { rootSchema, documents });
    return {
        errors: function (value) {
            const errors = [];
            validateNode(schema, value, [], errors, rootSchema, documents);
            return errors;
        },
        isValid: function (value) {
            return this.errors(value).length === 0;
        },
    };
}

function validate(schema, value, options) {
    return createValidator(schema, options).errors(value);
}

module.exports = {
    SCHEMA_KEYWORDS,
    assertSupportedSchema,
    createValidator,
    isPlainObject,
    pathText,
    validate,
};
