const LEMON_API = "https://api.lemonsqueezy.com/v1/licenses";

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (origin !== env.ALLOWED_ORIGIN) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function json(request, env, body, status = 200) {
  const headers = corsHeaders(request, env);
  if (!headers) return new Response(JSON.stringify({ error: "Origin not allowed." }), { status: 403, headers: { "Content-Type": "application/json" } });
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

function validInstallationId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9-]{16,100}$/.test(value);
}

async function lemon(path, values) {
  const response = await fetch(`${LEMON_API}/${path}`, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(values)
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function isTwimarkPro(data, env, email) {
  const responseEmail = data.meta?.customer_email?.trim().toLowerCase();
  return String(data.meta?.product_id) === String(env.LEMON_PRODUCT_ID)
    && data.license_key?.status === "active"
    && responseEmail === email.trim().toLowerCase();
}

async function parseBody(request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.licenseKey !== "string" || typeof body.email !== "string") return null;
  return body;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      const headers = corsHeaders(request, env);
      return headers ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 });
    }
    if (request.method !== "POST") return json(request, env, { error: "Not found." }, 404);

    const url = new URL(request.url);
    const body = await parseBody(request);
    if (!body || !validInstallationId(body.installationId)) {
      return json(request, env, { error: "Invalid license request." }, 400);
    }

    if (url.pathname === "/activate") {
      const { data } = await lemon("activate", {
        license_key: body.licenseKey.trim(),
        instance_name: `Twimark ${body.installationId.slice(0, 12)}`
      });
      if (!data.activated || !isTwimarkPro(data, env, body.email)) {
        return json(request, env, { error: data.error || "This key is not a valid Twimark Pro license." }, 403);
      }
      return json(request, env, { ok: true, instanceId: data.instance?.id });
    }

    if (url.pathname === "/validate") {
      if (typeof body.instanceId !== "string") return json(request, env, { error: "Missing license instance." }, 400);
      const { data } = await lemon("validate", {
        license_key: body.licenseKey.trim(),
        instance_id: body.instanceId
      });
      if (!data.valid || !isTwimarkPro(data, env, body.email)) {
        return json(request, env, { error: data.error || "Your Twimark Pro license is not active." }, 403);
      }
      return json(request, env, { ok: true });
    }

    if (url.pathname === "/deactivate") {
      if (typeof body.instanceId !== "string") return json(request, env, { error: "Missing license instance." }, 400);
      const { data } = await lemon("deactivate", {
        license_key: body.licenseKey.trim(),
        instance_id: body.instanceId
      });
      if (!data.deactivated) return json(request, env, { error: data.error || "Could not deactivate this device." }, 400);
      return json(request, env, { ok: true });
    }

    return json(request, env, { error: "Not found." }, 404);
  }
};
