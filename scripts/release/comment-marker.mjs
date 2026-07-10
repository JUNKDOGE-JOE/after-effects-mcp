const MARKER = '<!-- ae-mcp-rc-attestation:v1 -->';
const FENCE = '```';
const MAX_COMMENT_BYTES = 128 * 1024;
const BLOCK = /^\s*<!-- ae-mcp-rc-attestation:v1 -->[ \t]*\r?\n(?:[ \t]*\r?\n)*```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*\s*$/;

function occurrenceCount(value, token) {
  return value.split(token).length - 1;
}

export function encodeAttestationComment(report) {
  const json = JSON.stringify(report, null, 2);
  if (json === undefined) throw new Error('attestation report is not JSON serializable');
  if (json.includes(MARKER) || json.includes(FENCE)) {
    throw new Error('unsafe attestation marker content');
  }
  const body = `${MARKER}\n\n${FENCE}json\n${json}\n${FENCE}\n`;
  if (Buffer.byteLength(body) > MAX_COMMENT_BYTES) throw new Error('attestation comment is too large');
  return body;
}

export function decodeAttestationComment(body) {
  const text = String(body ?? '');
  if (Buffer.byteLength(text) > MAX_COMMENT_BYTES) {
    throw new Error('attestation comment is too large');
  }
  if (occurrenceCount(text, MARKER) !== 1) {
    throw new Error('expected exactly one attestation marker');
  }
  if (occurrenceCount(text, FENCE) !== 2) {
    throw new Error('expected exactly one JSON fence');
  }
  const match = BLOCK.exec(text);
  if (!match) throw new Error('invalid attestation marker format');

  const report = JSON.parse(match[1]);
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('attestation payload must be an object');
  }
  if (JSON.stringify(report, null, 2) !== match[1]) {
    throw new Error('attestation JSON must be canonical');
  }
  return report;
}
