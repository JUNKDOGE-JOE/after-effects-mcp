// Newline-delimited JSON framing shared by CLI streams and the MCP client.
// Pure functions; no CEP or Node dependencies.

// Accumulates stream chunks and invokes onLine(line) for every complete,
// trimmed, non-empty line. Handles lines torn across chunks and CRLF.
export function createLineSplitter(onLine) {
  let buffer = '';
  const decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;
  function textFor(chunk) {
    if (typeof chunk === 'string') return chunk;
    if (decoder && chunk !== undefined && chunk !== null) {
      try {
        // Streaming decode retains an incomplete multibyte sequence until the
        // next chunk instead of silently replacing it with U+FFFD.
        return decoder.decode(chunk, { stream: true });
      } catch {}
    }
    return String(chunk || '');
  }
  return function push(chunk) {
    buffer += textFor(chunk);
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
