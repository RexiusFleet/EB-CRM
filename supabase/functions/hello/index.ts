/**
 * Minimal Edge Function, for isolating a deploy problem.
 *
 * Deploy this as a function named `hello`, then point the probe at it. It has
 * no imports, no environment variables, no secrets and no calls out to anything
 * -- so if this one answers and `calendar` does not, the platform and the deploy
 * path are fine and the fault is in the calendar function's code or its paste.
 * If this one does not answer either, the problem is upstream of any code I
 * wrote, and the function logs are the place to look.
 */

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-user-token',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

Deno.serve((req: Request) => {
  // The preflight must be answered before anything else, and without touching
  // headers or a body -- this is the request that fails when a gateway check
  // rejects it, and the one worth proving in isolation.
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  return new Response(
    JSON.stringify({
      ok: true,
      hello: 'the function is running',
      method: req.method,
      sawAuthHeader: !!req.headers.get('Authorization'),
      sawApiKey: !!req.headers.get('apikey'),
      time: new Date().toISOString(),
    }),
    { headers: { ...cors, 'Content-Type': 'application/json' } },
  );
});
