import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  NATIVE_EXEC_INPUT_SCHEMA,
  NATIVE_EXEC_REGISTRY_DIGEST,
  PRIMITIVES,
} from './native_exec.generated.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(here, 'native_exec.generated.json');

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

fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
