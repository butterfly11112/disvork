// Minimal zero-dependency HTTP router with :param support.

export function createRouter() {
  const routes = [];

  function add(method, pattern, ...handlers) {
    const paramNames = [];
    const regexStr = pattern
      .replace(/\/:([a-zA-Z0-9_]+)/g, (_, name) => {
        paramNames.push(name);
        return '/([^/]+)';
      });
    const regex = new RegExp(`^${regexStr}$`);
    routes.push({ method, regex, paramNames, handlers });
  }

  function match(method, pathname) {
    for (const route of routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      route.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
      return { handlers: route.handlers, params };
    }
    return null;
  }

  return {
    get: (p, ...h) => add('GET', p, ...h),
    post: (p, ...h) => add('POST', p, ...h),
    patch: (p, ...h) => add('PATCH', p, ...h),
    delete: (p, ...h) => add('DELETE', p, ...h),
    match,
  };
}

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    const MAX = 1024 * 1024; // 1MB
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX) { reject(new Error('Payload too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
