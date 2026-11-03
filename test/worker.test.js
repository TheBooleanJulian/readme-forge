// node --test   worker.js against a fake GitHub API (global fetch) and a fake LLM gateway binding.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker.js';

let realFetch, gateway, repoPrivate;

beforeEach(() => {
  repoPrivate = false;
  gateway = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    const path = u.pathname.replace(/^\/repos\/acme\/widget/, '');
    if (u.hostname === 'raw.example') return new Response('{"name":"widget"}');
    if (path === '') return Response.json({ name: 'widget', description: 'A widget', default_branch: 'main', private: repoPrivate, topics: [] });
    if (path === '/languages') return Response.json({ JavaScript: 100 });
    if (path === '/contents') return Response.json([{ name: 'package.json', type: 'file', download_url: 'https://raw.example/p' }, { name: 'hero.png', type: 'file', path: 'hero.png' }]);
    if (path === '/commits') return Response.json([{ commit: { message: 'feat: first', author: { date: '2026-10-01T00:00:00Z' } } }]);
    if (path === '/tags') return Response.json([]);
    return new Response('nope', { status: 404 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const llm = (reply = '```markdown\n# widget\n```', status = 200) => ({
  fetch: async (url, init) => {
    gateway.push({ headers: init.headers, body: JSON.parse(init.body) });
    return status === 200
      ? Response.json({ choices: [{ message: { content: reply } }] })
      : Response.json({ error: { code: 'all_providers_failed' } }, { status });
  }
});
const env = (extra = {}) => ({ LLM: llm(), ASSETS: { fetch: async () => new Response('page') }, ...extra });
const generate = (e, body = { owner: 'acme', repo: 'widget' }) =>
  worker.fetch(new Request('https://rf/api/generate', { method: 'POST', body: JSON.stringify(body), headers: { 'CF-Connecting-IP': '1.2.3.4' } }), e);

test('public repo: prompt goes to the gateway as readme-generate, fences stripped', async () => {
  const res = await generate(env());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: '# widget', owner: 'acme', repo: 'widget' });
  assert.equal(gateway[0].headers['X-TBJ-Service'], 'readme-forge');
  assert.equal(gateway[0].headers['X-TBJ-Use-Case'], 'readme-generate');
  const prompt = gateway[0].body.messages[0].content;
  assert.match(prompt, /HERO IMAGE: hero\.png/);
  assert.match(prompt, /--- package\.json ---/);
});

test('private repo uses the sensitive use case', async () => {
  repoPrivate = true;
  await generate(env(), { owner: 'acme', repo: 'widget', token: 'ghp_x' });
  assert.equal(gateway[0].headers['X-TBJ-Use-Case'], 'readme-generate-private');
});

test('bad input is refused before GitHub or the gateway is called', async () => {
  assert.equal((await generate(env(), { owner: 'acme/../x', repo: 'widget' })).status, 400);
  assert.equal((await generate(env(), { owner: 'acme', repo: 'widget', token: 5 })).status, 400);
  assert.equal(gateway.length, 0);
});

test('rate limit returns 429', async () => {
  const res = await generate(env({ GENERATE_LIMIT: { limit: async () => ({ success: false }) } }));
  assert.equal(res.status, 429);
  assert.equal(gateway.length, 0);
});

test('gateway failure becomes a 502 with a readable message', async () => {
  const res = await generate(env({ LLM: llm('', 502) }));
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /all_providers_failed/);
});

test('unknown repo surfaces the GitHub 404 message', async () => {
  const res = await generate(env(), { owner: 'acme', repo: 'missing' });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /Repo not found/);
});

test('GET /api/generate is 405; other paths go to the static page; /healthz reports the binding', async () => {
  assert.equal((await worker.fetch(new Request('https://rf/api/generate'), env())).status, 405);
  assert.equal(await (await worker.fetch(new Request('https://rf/anything'), env())).text(), 'page');
  assert.deepEqual(await (await worker.fetch(new Request('https://rf/healthz'), env())).json(), { status: 'pass', gateway: 'bound' });
});
