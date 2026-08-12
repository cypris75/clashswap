// Netlify adapter. All the logic lives in src/lib/api.mjs so the same routes
// run locally (scripts/dev-server.mjs) and would run unchanged on Vercel.
import { handleApiRequest } from '../../src/lib/api.mjs';

export default async (request) => {
  const url = new URL(request.url);
  const path = url.pathname
    .replace(/^\/\.netlify\/functions\/api/, '')
    .replace(/^\/api/, '');

  let body;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const raw = await request.text();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: 'Request body must be valid JSON.', code: 'invalid' });
      }
    }
  }

  const result = await handleApiRequest({ method: request.method, path, body });
  return json(result.status, result.body, result.headers);
};

function json(status, body, headers = {}) {
  if (body === null) return new Response(null, { status, headers });
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

export const config = {
  path: ['/api', '/api/*'],
};
