export function createHttpJsonRequester({ httpImpl, httpsImpl }) {
  return function requestJson({ url, headers = {}, timeoutMs = 8000 }) {
    return new Promise((resolve, reject) => {
      const target = url instanceof URL ? url : new URL(String(url));
      const transport = target.protocol === 'https:' ? httpsImpl
        : target.protocol === 'http:' ? httpImpl : null;
      if (!transport?.request) {
        reject(new Error('HTTP transport is unavailable'));
        return;
      }
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      // CEP mixed context: Node http.request only recognizes its own URL class.
      const req = transport.request(target.toString(), { method: 'GET', headers }, (res) => {
        let text = '';
        res.setEncoding?.('utf8');
        res.on('data', (chunk) => { text += String(chunk); });
        // A destroyed response must reject here, never escape as an uncaught error.
        res.on('error', (error) => finish(reject, error));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* response stays non-JSON */ }
          const status = Number(res.statusCode || 0);
          finish(resolve, { ok: status >= 200 && status < 300, status, json, text });
        });
      });
      req.on('error', (error) => finish(reject, error));
      req.setTimeout(timeoutMs, () => {
        const error = new Error('Request timed out');
        error.code = 'ETIMEDOUT';
        req.destroy(error);
        finish(reject, error);
      });
      req.end();
    });
  };
}
