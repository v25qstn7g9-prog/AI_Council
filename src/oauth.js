/**
 * oauth.js — Minimal OAuth 2.1 authorization server for the /mcp endpoint.
 *
 * Claude's remote-MCP connector expects a real OAuth "sign in" flow (it does not have
 * a field for pasting a static bearer token), so this implements just enough of the
 * MCP Authorization spec for that flow to work, with Johnny as the only user:
 *
 *   1. GET  /.well-known/oauth-protected-resource   → tells the client which AS to use
 *   2. GET  /.well-known/oauth-authorization-server  → AS metadata (endpoints it supports)
 *   3. POST /oauth/register                          → Dynamic Client Registration (RFC 7591)
 *   4. GET  /authorize                                → shows a one-field login form
 *   5. POST /authorize                                → checks the password, issues a code
 *   6. POST /oauth/token                               → exchanges code (+ PKCE) for a token
 *
 * No third-party identity provider, no client secret (public client + PKCE S256 only).
 * "Login" is just the existing MCP_TOKEN secret typed into a password field once;
 * Claude then stores the issued access token and reuses it.
 *
 * All state (registered clients, one-time codes, issued tokens) lives in the existing
 * `council_kv` KV binding under an "oauth:" prefix so no new Cloudflare resource is needed.
 */

const CODE_TTL_SECONDS = 300; // 5 分鐘內要完成換 token，過期就要重新登入
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 天；之後 Claude 端會自己重新走一次登入
const CLIENT_TTL_SECONDS = 60 * 60 * 24 * 180; // 半年；DCR 註冊的 client 太久沒用就過期

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
  });
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function randomToken(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return base64url(arr);
}

function base64url(bytes) {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Base64Url(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64url(new Uint8Array(digest));
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function kvGetJSON(env, key) {
  if (!env.council_kv) return null;
  const raw = await env.council_kv.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function kvPutJSON(env, key, value, ttlSeconds) {
  if (!env.council_kv) throw new Error("尚未綁定 council_kv，OAuth 無法保存狀態");
  await env.council_kv.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
}

async function kvDelete(env, key) {
  if (!env.council_kv) return;
  await env.council_kv.delete(key);
}

async function readSecret(env, name) {
  let value = env?.[name];
  try {
    if (value && typeof value.get === "function") value = await value.get();
  } catch {
    return "";
  }
  return String(value || "").trim();
}

/**
 * 常數時間比對，跟 worker.js / mcp.js 其他驗證同一招，避免 timing attack。
 */
async function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const encoder = new TextEncoder();
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const left = new Uint8Array(aHash);
  const right = new Uint8Array(bHash);
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) difference |= left[i] ^ right[i];
  return difference === 0;
}

export function protectedResourceMetadata(origin) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
  };
}

export function authorizationServerMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  };
}

export async function handleClientRegistration(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_client_metadata", error_description: "請求不是合法 JSON" }, 400);
  }
  const redirectUris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === "string" && u) : [];
  if (!redirectUris.length) {
    return json({ error: "invalid_client_metadata", error_description: "redirect_uris 不能是空的" }, 400);
  }
  const clientId = randomToken(16);
  const record = {
    client_id: clientId,
    client_name: String(body?.client_name || "").slice(0, 200),
    redirect_uris: redirectUris.slice(0, 10),
    created_at: Date.now(),
  };
  await kvPutJSON(env, `oauth:client:${clientId}`, record, CLIENT_TTL_SECONDS);
  return json(
    {
      client_id: clientId,
      client_name: record.client_name,
      redirect_uris: record.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      client_id_issued_at: Math.floor(record.created_at / 1000),
    },
    201
  );
}

function loginForm({ clientId, redirectUri, state, codeChallenge, codeChallengeMethod, resource, error }) {
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI 圓桌 · 授權登入</title>
<style>
body{font-family:system-ui,-apple-system,"PingFang TC","Microsoft JhengHei",sans-serif;background:#0f1320;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
form{background:#1a1f30;padding:32px;border-radius:16px;width:min(360px,90vw);box-shadow:0 8px 30px rgba(0,0,0,.3)}
h1{font-size:18px;margin:0 0 8px}
p{font-size:13px;color:#9aa;margin:0 0 20px}
input[type=password]{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #333;background:#0f1320;color:#eee;font-size:15px;margin-bottom:16px}
button{width:100%;padding:12px;border-radius:8px;border:none;background:#e9b949;color:#1a1f30;font-weight:600;font-size:15px;cursor:pointer}
.err{color:#ff8080;font-size:13px;margin-bottom:12px}
</style></head>
<body>
<form method="post">
<h1>讓好答案，經得起推敲</h1>
<p>Claude 正在請求存取你的 AI 圓桌。輸入 MCP_TOKEN 以授權。</p>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
<input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
<input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
<input type="hidden" name="state" value="${escapeHtml(state)}">
<input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
<input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}">
<input type="hidden" name="resource" value="${escapeHtml(resource || "")}">
<input type="password" name="token" placeholder="MCP_TOKEN" required autofocus>
<button type="submit">授權</button>
</form>
</body></html>`;
}

async function validateAuthorizeParams(env, params) {
  const clientId = params.get("client_id") || "";
  const redirectUri = params.get("redirect_uri") || "";
  const codeChallenge = params.get("code_challenge") || "";
  const codeChallengeMethod = params.get("code_challenge_method") || "";
  const responseType = params.get("response_type") || "";
  const state = params.get("state") || "";
  const resource = params.get("resource") || "";

  if (responseType !== "code") return { ok: false, message: "只支援 response_type=code" };
  if (codeChallengeMethod !== "S256") return { ok: false, message: "只支援 code_challenge_method=S256（PKCE）" };
  if (!codeChallenge) return { ok: false, message: "缺少 code_challenge" };

  const client = await kvGetJSON(env, `oauth:client:${clientId}`);
  if (!client) return { ok: false, message: "未知的 client_id，請重新連接" };
  if (!client.redirect_uris.includes(redirectUri)) return { ok: false, message: "redirect_uri 跟註冊時不一致" };

  return { ok: true, clientId, redirectUri, codeChallenge, codeChallengeMethod, state, resource };
}

export async function handleAuthorizeGet(request, env) {
  const url = new URL(request.url);
  const validated = await validateAuthorizeParams(env, url.searchParams);
  if (!validated.ok) return html(`<p>${escapeHtml(validated.message)}</p>`, 400);
  return html(loginForm(validated));
}

export async function handleAuthorizePost(request, env) {
  const form = await request.formData();
  const params = new URLSearchParams();
  for (const key of ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "resource"]) {
    params.set(key, String(form.get(key) || ""));
  }
  params.set("response_type", "code");

  const validated = await validateAuthorizeParams(env, params);
  if (!validated.ok) return html(`<p>${escapeHtml(validated.message)}</p>`, 400);

  const configuredToken = await readSecret(env, "MCP_TOKEN");
  if (!configuredToken) return html("<p>尚未設定 MCP_TOKEN，MCP 登入已停用</p>", 403);

  const given = String(form.get("token") || "");
  const isValid = await safeCompare(given, configuredToken);
  if (!isValid) {
    return html(loginForm({ ...validated, error: "Token 不正確，請再試一次" }), 401);
  }

  const code = randomToken(24);
  await kvPutJSON(
    env,
    `oauth:code:${code}`,
    {
      client_id: validated.clientId,
      redirect_uri: validated.redirectUri,
      code_challenge: validated.codeChallenge,
      resource: validated.resource,
    },
    CODE_TTL_SECONDS
  );

  const redirectUrl = new URL(validated.redirectUri);
  redirectUrl.searchParams.set("code", code);
  if (validated.state) redirectUrl.searchParams.set("state", validated.state);
  return Response.redirect(redirectUrl.toString(), 302);
}

export async function handleToken(request, env) {
  const contentType = request.headers.get("content-type") || "";
  let params;
  if (contentType.includes("application/json")) {
    const body = await request.json().catch(() => ({}));
    params = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]));
  } else {
    params = new URLSearchParams(await request.text());
  }

  const grantType = params.get("grant_type");
  if (grantType !== "authorization_code") {
    return json({ error: "unsupported_grant_type" }, 400);
  }

  const code = params.get("code") || "";
  const record = await kvGetJSON(env, `oauth:code:${code}`);
  if (!record) return json({ error: "invalid_grant", error_description: "code 不存在或已過期" }, 400);
  await kvDelete(env, `oauth:code:${code}`); // 一次性使用

  if (params.get("client_id") !== record.client_id) return json({ error: "invalid_grant", error_description: "client_id 不符" }, 400);
  if (params.get("redirect_uri") !== record.redirect_uri) return json({ error: "invalid_grant", error_description: "redirect_uri 不符" }, 400);

  const verifier = params.get("code_verifier") || "";
  const expected = await sha256Base64Url(verifier);
  if (expected !== record.code_challenge) return json({ error: "invalid_grant", error_description: "PKCE 驗證失敗" }, 400);

  const accessToken = randomToken(32);
  await kvPutJSON(env, `oauth:token:${accessToken}`, { client_id: record.client_id }, TOKEN_TTL_SECONDS);

  return json({ access_token: accessToken, token_type: "bearer", expires_in: TOKEN_TTL_SECONDS });
}

/**
 * /mcp 的驗證：檢查 Authorization: Bearer <access_token> 是否是我們透過上面流程發出去的。
 */
export async function verifyAccessToken(request, env) {
  const header = request.headers.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false };
  const record = await kvGetJSON(env, `oauth:token:${token}`);
  if (!record) return { ok: false };
  return { ok: true, clientId: record.client_id };
}

export function unauthorizedMcpResponse(origin) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "需要登入授權" } }), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    },
  });
}

export async function handleOAuthWellKnown(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/.well-known/oauth-protected-resource") {
    return json(protectedResourceMetadata(url.origin));
  }
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    return json(authorizationServerMetadata(url.origin));
  }
  return json({ error: "not_found" }, 404);
}
