import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// The vendored Turndown build uses require() for its DOM parser.
globalThis.require = createRequire(import.meta.url);
const { default: worker } = await import('../src/index.js');

const publicOrigin = 'https://public.example';
const ghostOrigin = 'https://ghost.example';
const env = { GHOST_API_KEY: 'test-key', GHOST_URL: ghostOrigin };

function entry(slug, overrides = {}) {
  return {
    slug,
    title: slug === 'about' ? 'About us' : 'Example post',
    url: `${ghostOrigin}/${slug}/`,
    html: '<p>Article body.</p>',
    access: true,
    published_at: '2026-10-01T08:00:00.000Z',
    updated_at: '2026-10-02T08:00:00.000Z',
    primary_author: { name: 'Jane Doe' },
    authors: [{ name: 'Jane Doe' }],
    tags: [{ name: 'Guides' }],
    ...overrides,
  };
}

function setup({ posts = [], featured = [], pages = [], detailPosts = {}, detailPages = {}, htmlStatus = 200 } = {}) {
  const cache = new Map();
  const calls = [];
  const pending = [];
  const injected = [];
  globalThis.caches = {
    default: {
      async match(key) { return cache.get(key.url)?.clone(); },
      async put(key, response) { cache.set(key.url, response.clone()); },
    },
  };
  globalThis.HTMLRewriter = class {
    on(selector, handler) {
      assert.equal(selector, 'head');
      this.handler = handler;
      return this;
    }
    transform(response) {
      this.handler.element({ append(value) { injected.push(value); } });
      return response;
    }
  };
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    calls.push(url.toString());
    if (url.origin === publicOrigin) {
      return new Response('<html><head></head><body>Original</body></html>', {
        status: htmlStatus,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    assert.equal(url.origin, ghostOrigin);
    if (url.pathname.endsWith('/settings/')) {
      return Response.json({ settings: { title: 'Example site', description: 'Original reporting', lang: 'en' } });
    }
    if (url.pathname.endsWith('/posts/')) {
      return Response.json({ posts: url.searchParams.get('filter') === 'featured:true' ? featured : posts });
    }
    if (url.pathname.endsWith('/pages/')) return Response.json({ pages });
    const match = url.pathname.match(/\/(posts|pages)\/slug\/([^/]+)\/$/);
    assert.ok(match, `unexpected Ghost URL: ${url}`);
    const item = (match[1] === 'posts' ? detailPosts : detailPages)[match[2]];
    return item
      ? Response.json({ [match[1]]: [item] })
      : new Response('Not found', { status: 404 });
  };
  return {
    calls,
    injected,
    ctx: { waitUntil(promise) { pending.push(promise); } },
    async flush() { await Promise.all(pending); },
  };
}

test('llms.txt uses public links, includes pages and featured posts, and skips inaccessible content', async () => {
  const featuredPost = entry('evergreen', { title: 'Evergreen guide', custom_excerpt: 'Still useful' });
  const recentPost = entry('recent', { title: 'Recent update' });
  const unusualPath = entry('unusual', { url: `${ghostOrigin}//other.example/path/` });
  const about = entry('about', { title: 'About us' });
  const harness = setup({
    pages: [about, entry('members', { access: false, html: '' })],
    featured: [featuredPost],
    posts: [featuredPost, recentPost, unusualPath],
  });

  const response = await worker.fetch(new Request(`${publicOrigin}/llms.txt`), env, harness.ctx);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /## Pages\n\n- \[About us\]\(https:\/\/public\.example\/about\.md\)/);
  assert.match(body, /## Featured posts\n\n- \[Evergreen guide\]\(https:\/\/public\.example\/evergreen\.md\): Still useful/);
  assert.match(body, /## Recent posts\n\n- \[Recent update\]/);
  assert.equal((body.match(/evergreen\.md/g) || []).length, 1);
  assert.match(body, /https:\/\/public\.example\/\/other\.example\/path\.md/);
  assert.doesNotMatch(body, /https:\/\/other\.example/);
  assert.doesNotMatch(body, /ghost\.example|members\.md/);
  await harness.flush();

  const before = harness.calls.length;
  const head = await worker.fetch(new Request(`${publicOrigin}/llms.txt`, { method: 'HEAD' }), env, harness.ctx);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(harness.calls.length, before);
});

test('Ghost pages have working Markdown alternates and custom canonical URLs', async () => {
  const about = entry('about', {
    title: 'About us',
    canonical_url: 'https://canonical.example/about/',
    html: '<h2>Our work</h2><p>Independent research.</p>',
  });
  const harness = setup({ detailPages: { about } });
  const response = await worker.fetch(new Request(`${publicOrigin}/about.md`), env, harness.ctx);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /content_type: "page"/);
  assert.match(body, /canonical_url: "https:\/\/canonical\.example\/about\/"/);
  assert.match(body, /# About us\n\n## Our work/);
  assert.match(response.headers.get('Link'), /llms\.txt>; rel="describedby"/);
  assert.ok(harness.calls.some((url) => url.includes('/pages/slug/about/')));
  await harness.flush();
});

test('post Markdown retains image context, bookmark descriptions and table structure', async () => {
  const post = entry('example', {
    title: 'A detailed example',
    url: `${ghostOrigin}/notes/example/`,
    feature_image: `${ghostOrigin}/cover.jpg`,
    feature_image_alt: 'Cover illustration',
    feature_image_caption: 'Cover credit',
    html: '<p>Original findings.</p>'
      + '<figure class="kg-image-card"><img src="https://images.example/chart.jpg" alt="Bar chart"><figcaption>Annual totals</figcaption></figure>'
      + '<figure class="kg-bookmark-card"><a class="kg-bookmark-container" href="https://source.example/report"><div class="kg-bookmark-title">Source report</div><div class="kg-bookmark-description">Underlying data</div></a></figure>'
      + '<table><tr><th>Year</th><th>Total</th></tr><tr><td>2026</td><td>42</td></tr></table>',
  });
  const harness = setup({ detailPosts: { example: post } });
  const response = await worker.fetch(new Request(`${publicOrigin}/notes/example.md`), env, harness.ctx);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /canonical_url: "https:\/\/public\.example\/notes\/example\/"/);
  assert.match(body, /# A detailed example/);
  assert.match(body, /!\[Cover illustration\]\(https:\/\/ghost\.example\/cover\.jpg\)\n\n\*Cover credit\*/);
  assert.match(body, /!\[Bar chart\]\(https:\/\/images\.example\/chart\.jpg\)\n\n\*Annual totals\*/);
  assert.match(body, /\[Source report\]\(https:\/\/source\.example\/report\) — Underlying data/);
  assert.match(body, /\| Year \| Total \|\n\| --- \| --- \|\n\| 2026 \| 42 \|/);
  await harness.flush();

  const before = harness.calls.length;
  const negotiated = await worker.fetch(new Request(`${publicOrigin}/notes/example/`, {
    headers: { Accept: 'text/markdown' },
  }), env, harness.ctx);
  assert.equal(await negotiated.text(), body);
  assert.equal(harness.calls.length, before, 'cached Markdown avoids all Ghost requests');
});

test('HTML responses advertise Markdown and llms.txt, but errors do not', async () => {
  const harness = setup();
  const response = await worker.fetch(new Request(`${publicOrigin}/about/`), env, harness.ctx);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Link'), /about\.md>; rel="alternate"; type="text\/markdown"/);
  assert.match(response.headers.get('Link'), /llms\.txt>; rel="describedby"/);
  assert.ok(harness.injected.some((value) => value.includes('rel="alternate"')));
  assert.ok(harness.injected.some((value) => value.includes('rel="describedby"')));

  const home = await worker.fetch(new Request(`${publicOrigin}/`), env, harness.ctx);
  assert.match(home.headers.get('Link'), /llms\.txt>; rel="describedby"/);
  assert.doesNotMatch(home.headers.get('Link'), /rel="alternate"/);

  const admin = await worker.fetch(new Request(`${publicOrigin}/ghost/`), env, harness.ctx);
  assert.equal(admin.headers.get('Link'), null);

  const failing = setup({ htmlStatus: 404 });
  const missing = await worker.fetch(new Request(`${publicOrigin}/missing/`), env, failing.ctx);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('Link'), null);
  assert.equal(failing.injected.length, 0);
});
