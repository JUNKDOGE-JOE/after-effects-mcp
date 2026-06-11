export function createSseParser(onEvent) {
  let buffer = '';

  function parseFrame(frame) {
    let event = '';
    let data = '';
    const lines = frame.replace(/\r\n/g, '\n').split('\n');
    for (const line of lines) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data += line.slice(5).trimStart();
      }
    }

    const trimmed = data.trim();
    if (!trimmed || trimmed === '[DONE]') return;

    try {
      onEvent({ event, data: JSON.parse(trimmed) });
    } catch (e) {
      // Keep streaming on malformed keep-alive or diagnostic frames.
    }
  }

  function feed(chunkText) {
    buffer += String(chunkText || '');
    buffer = buffer.replace(/\r\n/g, '\n');

    let splitAt = buffer.indexOf('\n\n');
    while (splitAt !== -1) {
      const frame = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt + 2);
      parseFrame(frame);
      splitAt = buffer.indexOf('\n\n');
    }
  }

  return { feed };
}
