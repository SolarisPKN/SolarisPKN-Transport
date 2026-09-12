import { refreshLive } from './runtime.js';

function corsHeaders(request, config) {
  const origin = request.headers.get('Origin');
  const allowed = new Set(config.deployment.allowedOrigins || []);
  return origin && allowed.has(origin) ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, If-None-Match, Range',
    'Access-Control-Expose-Headers': 'ETag, Content-Length, Content-Range',
    Vary: 'Origin',
  } : {};
}

export default {
  async scheduled(event, env, context) {
    context.waitUntil(refreshLive(env, event.scheduledTime, __LIVE_CONFIG__));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, __LIVE_CONFIG__) });
    if (!['GET', 'HEAD'].includes(request.method) || url.pathname !== '/current.json') return new Response('Not found', { status: 404 });
    const origin = request.headers.get('Origin');
    if (origin && !(__LIVE_CONFIG__.deployment.allowedOrigins || []).includes(origin)) return new Response('Forbidden', { status: 403 });
    const object = await env.TRANSPORT_LIVE.get(__LIVE_CONFIG__.deployment.currentKey);
    if (!object) return new Response('Unavailable', { status: 503, headers: { 'Retry-After': '60' } });
    const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=30, stale-while-revalidate=90', ...corsHeaders(request, __LIVE_CONFIG__) });
    object.writeHttpMetadata(headers);
    headers.set('ETag', object.httpEtag);
    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  },
};
