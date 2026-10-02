import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleOAuthWellKnown,
  handleClientRegistration,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleToken,
  verifyAccessToken,
} from '../src/oauth.js';

function fakeKv() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

function baseEnv() {
  return { council_kv: fakeKv(), MCP_TOKEN: 'secret-token' };
}

async function pkcePair() {
  const verifier = 'a'.repeat(64);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const bytes = new Uint8Array(digest);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  const challenge = btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge };
}

async function registerClient(env, redirectUri = 'https://claude.ai/mcp/callback') {
  const request = new Request('https://council.test/oauth/register', {
    method: 'POST',
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: 'Claude' }),
  });
  const response = await handleClientRegistration(request, env);
  assert.equal(response.status, 201);
  return response.json();
}

test('well-known metadata points to this server as its own authorization server', async () => {
  const env = baseEnv();
  const resource = await (await handleOAuthWellKnown(new Request('https://council.test/.well-known/oauth-protected-resource'), env)).json();
  assert.equal(resource.resource, 'https://council.test/mcp');
  assert.deepEqual(resource.authorization_servers, ['https://council.test']);

  const as = await (await handleOAuthWellKnown(new Request('https://council.test/.well-known/oauth-authorization-server'), env)).json();
  assert.equal(as.token_endpoint, 'https://council.test/oauth/token');
  assert.ok(as.code_challenge_methods_supported.includes('S256'));
});

test('dynamic client registration rejects missing redirect_uris', async () => {
  const env = baseEnv();
  const request = new Request('https://council.test/oauth/register', { method: 'POST', body: JSON.stringify({}) });
  const response = await handleClientRegistration(request, env);
  assert.equal(response.status, 400);
});

test('full authorization-code + PKCE flow issues a working access token', async () => {
  const env = baseEnv();
  const redirectUri = 'https://claude.ai/mcp/callback';
  const client = await registerClient(env, redirectUri);
  const { verifier, challenge } = await pkcePair();

  const authorizeUrl = new URL('https://council.test/authorize');
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', client.client_id);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('state', 'xyz');

  const getResponse = await handleAuthorizeGet(new Request(authorizeUrl), env);
  assert.equal(getResponse.status, 200);
  assert.match(await getResponse.text(), /MCP_TOKEN/);

  const form = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    state: 'xyz',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    token: 'secret-token',
  });
  const postResponse = await handleAuthorizePost(
    new Request(authorizeUrl, { method: 'POST', body: form }),
    env
  );
  assert.equal(postResponse.status, 302);
  const redirectedTo = new URL(postResponse.headers.get('location'));
  assert.equal(redirectedTo.origin + redirectedTo.pathname, redirectUri);
  assert.equal(redirectedTo.searchParams.get('state'), 'xyz');
  const code = redirectedTo.searchParams.get('code');
  assert.ok(code);

  const tokenForm = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    code_verifier: verifier,
  });
  const tokenResponse = await handleToken(
    new Request('https://council.test/oauth/token', { method: 'POST', body: tokenForm }),
    env
  );
  assert.equal(tokenResponse.status, 200);
  const tokenBody = await tokenResponse.json();
  assert.equal(tokenBody.token_type, 'bearer');
  assert.ok(tokenBody.access_token);

  const verified = await verifyAccessToken(
    new Request('https://council.test/mcp', { headers: { authorization: `Bearer ${tokenBody.access_token}` } }),
    env
  );
  assert.equal(verified.ok, true);

  // authorization codes are one-time use
  const secondAttempt = await handleToken(
    new Request('https://council.test/oauth/token', { method: 'POST', body: tokenForm }),
    env
  );
  assert.equal(secondAttempt.status, 400);
});

test('wrong login password is rejected and issues no code', async () => {
  const env = baseEnv();
  const redirectUri = 'https://claude.ai/mcp/callback';
  const client = await registerClient(env, redirectUri);
  const { challenge } = await pkcePair();

  const form = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    state: 's',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    token: 'wrong-password',
  });
  const response = await handleAuthorizePost(
    new Request('https://council.test/authorize', { method: 'POST', body: form }),
    env
  );
  assert.equal(response.status, 401);
  assert.match(await response.text(), /不正確/);
});

test('token exchange rejects a PKCE verifier that does not match the challenge', async () => {
  const env = baseEnv();
  const redirectUri = 'https://claude.ai/mcp/callback';
  const client = await registerClient(env, redirectUri);
  const { challenge } = await pkcePair();

  const form = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    state: 's',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    token: 'secret-token',
  });
  const postResponse = await handleAuthorizePost(
    new Request('https://council.test/authorize', { method: 'POST', body: form }),
    env
  );
  const code = new URL(postResponse.headers.get('location')).searchParams.get('code');

  const tokenForm = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    code_verifier: 'totally-wrong-verifier',
  });
  const tokenResponse = await handleToken(
    new Request('https://council.test/oauth/token', { method: 'POST', body: tokenForm }),
    env
  );
  assert.equal(tokenResponse.status, 400);
  const body = await tokenResponse.json();
  assert.equal(body.error, 'invalid_grant');
});

test('authorize rejects an unregistered client_id or mismatched redirect_uri', async () => {
  const env = baseEnv();
  const client = await registerClient(env, 'https://claude.ai/mcp/callback');
  const { challenge } = await pkcePair();

  const unknownClientUrl = new URL('https://council.test/authorize');
  unknownClientUrl.searchParams.set('response_type', 'code');
  unknownClientUrl.searchParams.set('client_id', 'not-a-real-client');
  unknownClientUrl.searchParams.set('redirect_uri', 'https://claude.ai/mcp/callback');
  unknownClientUrl.searchParams.set('code_challenge', challenge);
  unknownClientUrl.searchParams.set('code_challenge_method', 'S256');
  const unknownClientResponse = await handleAuthorizeGet(new Request(unknownClientUrl), env);
  assert.equal(unknownClientResponse.status, 400);

  const badRedirectUrl = new URL('https://council.test/authorize');
  badRedirectUrl.searchParams.set('response_type', 'code');
  badRedirectUrl.searchParams.set('client_id', client.client_id);
  badRedirectUrl.searchParams.set('redirect_uri', 'https://evil.example/callback');
  badRedirectUrl.searchParams.set('code_challenge', challenge);
  badRedirectUrl.searchParams.set('code_challenge_method', 'S256');
  const badRedirectResponse = await handleAuthorizeGet(new Request(badRedirectUrl), env);
  assert.equal(badRedirectResponse.status, 400);
});
