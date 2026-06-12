// Newline-delimited JSON framing shared by stdio transports (MCP client,
// claude-agent sidecar). Pure functions; no CEP or Node dependencies.

// Accumulates stream chunks and invokes onLine(line) for every complete,
// trimmed, non-empty line. Handles lines torn across chunks and CRLF.
export function createLineSplitter(onLine) {
  let buffer = '';
  return function push(chunk) {
    buffer += String(chunk || '');
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
      index = buffer.indexOf('\n');
    }
  };
}

// Line splitter that JSON-parses each line and invokes onMessage(message).
// Non-JSON lines (stray log contamination) are skipped silently; valid
// stdio protocol output is JSON lines only.
export function createNdjsonReader(onMessage) {
  return createLineSplitter((line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (e) {
      return;
    }
    onMessage(message);
  });
}
