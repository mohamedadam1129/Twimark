const LEMON_API = "https://api.lemonsqueezy.com/v1/licenses";

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  // Chrome Web Store keeps an extension ID stable, but unpacked, enterprise,
  // and previously packaged builds can have a different ID. The Worker never
  // grants access based on origin: Lemon Squeezy product/email/instance checks
  // below remain the entitlement boundary. Restricting this endpoint to Chrome
  // extension origins prevents ordinary websites from using it.
  const isChromeExtension = /^chrome-extension:\/\/[a-p]{32}$/.test(origin || "");
  if (origin !== env.ALLOWED_ORIGIN && !isChromeExtension) return null;
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

function matchesTwimarkCustomer(data, env, email) {
  const responseEmail = data.meta?.customer_email?.trim().toLowerCase();
  return String(data.meta?.product_id) === String(env.LEMON_PRODUCT_ID)
    && responseEmail === email.trim().toLowerCase();
}

function handoffPage(env, licenseKey, email) {
  const data = JSON.stringify({ licenseKey, email }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Activating Twimark Pro</title><style>body{margin:0;display:grid;min-height:100vh;place-items:center;background:#f4f7fb;color:#172033;font:16px system-ui}.card{max-width:440px;margin:20px;padding:28px;border:1px solid #dbe5f1;border-radius:18px;background:#fff;box-shadow:0 16px 35px #23415a20}h1{margin:0 0 8px}p{line-height:1.5;color:#526477}</style><div class="card"><h1 id="title">Activating Twimark Pro…</h1><p id="message">Please keep this page open for a moment.</p></div><script>const purchase=${data};const title=document.getElementById('title');const message=document.getElementById('message');if(!globalThis.chrome?.runtime?.sendMessage){title.textContent='Open Twimark to activate';message.textContent='Twimark is not installed in this browser. Install it, then use the license key in your receipt.'}else{chrome.runtime.sendMessage('${env.EXTENSION_ID}',{action:'activate_purchase',...purchase},(result)=>{if(chrome.runtime.lastError||!result?.ok){title.textContent='Activation needs a quick retry';message.textContent=result?.error||'Open Twimark, choose “Already have a license? Log in”, and enter the key from your receipt.';return}title.textContent='Twimark Pro is active!';message.textContent='Return to Twimark and export your full bookmark library.'})}</script></html>`;
}

function isActiveTwimarkPro(data, env, email) {
  return data.license_key?.status === "active" && matchesTwimarkCustomer(data, env, email);
}

async function parseBody(request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.licenseKey !== "string" || typeof body.email !== "string") return null;
  return body;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/activate") {
      const licenseKey = url.searchParams.get("license_key") || "";
      const email = url.searchParams.get("email") || "";
      return new Response(handoffPage(env, licenseKey, email), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }
      });
    }
    if (request.method === "OPTIONS") {
      const headers = corsHeaders(request, env);
      return headers ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 });
    }
    if (request.method !== "POST") return json(request, env, { error: "Not found." }, 404);

    const body = await parseBody(request);
    if (!body || !validInstallationId(body.installationId)) {
      return json(request, env, { error: "Invalid license request." }, 400);
    }

    if (url.pathname === "/activate") {
      const validation = await lemon("validate", { license_key: body.licenseKey.trim() });
      if (!validation.data.valid || !matchesTwimarkCustomer(validation.data, env, body.email)) {
        return json(request, env, { error: validation.data.error || "This key is not a valid Twimark Pro license." }, 403);
      }
      const { data } = await lemon("activate", {
        license_key: body.licenseKey.trim(),
        instance_name: `Twimark ${body.installationId.slice(0, 12)}`
      });
      if (!data.activated || !isActiveTwimarkPro(data, env, body.email)) {
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
      if (!data.valid || !isActiveTwimarkPro(data, env, body.email)) {
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
