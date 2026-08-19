import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  NATIVE_EXEC_INPUT_SCHEMA,
  NATIVE_EXEC_REGISTRY_DIGEST,
  PRIMITIVES,
} from './native_exec.generated.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// The CEP host cannot reach native/ at runtime (only plugin/ ships), so the JSON
// twin and a byte-identical copy of the RPC schema live under plugin/host/mcp/generated/.
const outputDir = path.join(here, '..', '..', '..', 'plugin', 'host', 'mcp', 'generated');
const outputPath = path.join(outputDir, 'native_exec.generated.json');
const schemaSource = path.join(here, 'aegp-rpc.schema.json');
const schemaOutput = path.join(outputDir, 'aegp-rpc.schema.json');

// CEP 11 cannot require the generated .mjs module. Keep only the generated
// fields needed by the host-side admission and result-contract checks; the
// .mjs file remains the source of truth for the native registry.
const output = {
  NATIVE_EXEC_INPUT_SCHEMA,
  NATIVE_EXEC_REGISTRY_DIGEST,
  PRIMITIVES: PRIMITIVES.map((primitive) => ({
    id: primitive.id,
    mutability: primitive.mutability,
    referenceArguments: primitive.referenceArguments,
    inputSchema: primitive.inputSchema,
    resultSchema: primitive.resultSchema,
    resultKind: primitive.resultKind,
    exportable: primitive.exportable,
  })),
};

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
fs.copyFileSync(schemaSource, schemaOutput);
