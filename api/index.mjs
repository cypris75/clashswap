// Vercel adapter — only used if you deploy to Vercel instead of Netlify.
// Same routes, same code: everything lives in src/lib/api.mjs.
import { handleApiRequest } from '../src/lib/api.mjs';

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = url.pathname.replace(/^\/api/, '');

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = req.body; // Vercel parses JSON bodies for us
    if (typeof body === 'string' && body) {
      try {
        body = JSON.parse(body);
      } catch {
        res.status(400).json({ error: 'Request body must be valid JSON.', code: 'invalid' });
        return;
      }
    }
  }

  const result = await handleApiRequest({ method: req.method, path, body });
  res.setHeader('cache-control', 'no-store');
  if (result.body === null) res.status(result.status).end();
  else res.status(result.status).json(result.body);
}
