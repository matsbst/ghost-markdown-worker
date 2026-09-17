import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let worker;
const post = {
  title: 'Example', slug: 'example', url: 'https://blog.test/notes/example/',
  published_at: '2026-01-01T00:00:00.000Z', tags: [{ name: 'Testing' }],
  primary_author: { name: 'Writer' },
  html: '<h2>Heading</h2><figure class="kg-image-card"><img src="https://blog.test/image.jpg"><figcaption>Caption</figcaption></figure><figure class="kg-bookmark-card"><a class="kg-bookmark-container" href="https://example.com"><span class="kg-bookmark-title">Bookmark</span></a></figure><pre><code class="language-js">const x = 1;</code></pre>',
};
before(async () => {
  const bundle = await build({ entryPoints: ['src/index.js'], bundle: true, write: false, format: 'esm', platform: 'node' });
  const outboundService = async (request) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/ghost/api/content/settings/')) return Response.json({ settings: { title: 'Test blog', description: 'A fixture', lang: 'en' } });
    if (path.startsWith('/ghost/api/content/posts/')) return Response.json({ posts: [post] });
    if (path === '/notes/example/' || path === '/tag/testing/') return new Response('<html><head></head><body>Original HTML</body></html>', { headers: { 'content-type': 'text/html' } });
    throw new Error(`Unexpected outbound request: ${request.url}`);
  };
  worker = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2024-12-01', compatibilityFlags: ['nodejs_compat'], bindings: { GHOST_API_KEY: 'fixture', GHOST_URL: 'https://blog.test' }, outboundService }));
});
after(async () => { await worker?.dispose(); });

test('Markdown converts Ghost cards, fenced code, and frontmatter', async () => {
  const response = await worker.dispatchFetch('https://blog.test/notes/example.md');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/markdown/);
  const body = await response.text();
  for (const expected of ['title: "Example"', 'lang: "en"', '## Heading', '![Caption](https://blog.test/image.jpg)', '[Bookmark](https://example.com)', '```js\nconst x = 1;\n```']) assert.ok(body.includes(expected), expected);
});
test('Accept negotiation matches .md and HEAD returns headers without a body', async () => {
  const explicit = await worker.dispatchFetch('https://blog.test/notes/example.md');
  const negotiated = await worker.dispatchFetch('https://blog.test/notes/example/', { headers: { Accept: 'text/markdown' } });
  assert.equal(await negotiated.text(), await explicit.text());
  assert.equal(negotiated.headers.get('vary'), 'Accept');
  const head = await worker.dispatchFetch('https://blog.test/notes/example.md', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
test('HTML keeps its representation and advertises nested Markdown URL', async () => {
  const response = await worker.dispatchFetch('https://blog.test/notes/example/');
  const body = await response.text();
  assert.ok(body.includes('Original HTML'));
  assert.ok(body.includes('<link rel="alternate" type="text/markdown" href="https://blog.test/notes/example.md" />'));
  assert.match(response.headers.get('link'), /notes\/example.md/);
  assert.equal(response.headers.get('vary'), 'Accept');
});
test('q=0 and collection paths remain HTML', async () => {
  const response = await worker.dispatchFetch('https://blog.test/notes/example/', { headers: { Accept: 'text/markdown;q=0' } });
  assert.match(response.headers.get('content-type'), /text\/html/);
  const collection = await worker.dispatchFetch('https://blog.test/tag/testing/', { headers: { Accept: 'text/markdown' } });
  assert.equal(collection.headers.get('link'), null);
  assert.ok(!(await collection.text()).includes('rel="alternate"'));
});
test('llms.txt lists canonical nested Markdown URLs', async () => {
  const response = await worker.dispatchFetch('https://blog.test/llms.txt');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(body.startsWith('# Test blog\n'));
  assert.ok(body.includes('[Example](https://blog.test/notes/example.md)'));
});
test('canonical mismatch and unsupported methods are rejected', async () => {
  assert.equal((await worker.dispatchFetch('https://blog.test/example.md')).status, 404);
  assert.equal((await worker.dispatchFetch('https://blog.test/notes/example.md', { method: 'POST' })).status, 405);
});
