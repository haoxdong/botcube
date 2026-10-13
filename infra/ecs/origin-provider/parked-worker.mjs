// Cloudflare Worker routed on the API hostnames while production is Parked
// (docs/runbooks/production-parking.md). The web UI reads this body across
// origins with credentials, so it carries the Chat Service's CORS grant.
export default {
  /**
   * @param {Request} request
   * @param {{ ALLOWED_ORIGINS: string }} env
   */
  async fetch(request, env) {
    const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin' });
    const origin = request.headers.get('Origin');
    if (origin && JSON.parse(env.ALLOWED_ORIGINS).includes(origin)) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Credentials', 'true');
    }
    if (request.method === 'OPTIONS' && request.headers.has('Access-Control-Request-Method')) {
      headers.set('Access-Control-Allow-Methods', 'DELETE, GET, POST, OPTIONS');
      const requested = request.headers.get('Access-Control-Request-Headers');
      if (requested) headers.set('Access-Control-Allow-Headers', requested);
      return new Response(null, { status: 204, headers });
    }
    headers.set('Content-Type', 'application/json');
    return new Response('{"status":"parked"}', { status: 503, headers });
  },
};
