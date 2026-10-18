# Ghost Markdown Worker

Give public Ghost posts and pages a Markdown version without changing their normal HTML URLs. This Cloudflare Worker also creates an `llms.txt` index and adds discovery links to HTML pages.

| Request | Result |
| --- | --- |
| `https://example.com/notes/my-post/` | The normal Ghost page, with a link to its Markdown version |
| `https://example.com/notes/my-post.md` | The same post as Markdown |
| `Accept: text/markdown` on the normal URL | The Markdown version |
| `https://example.com/llms.txt` | Links to public pages and selected posts |

Nested post and page URLs work too: `/notes/my-post/` becomes `/notes/my-post.md`.

## What's new in 1.1

- `llms.txt` lists public pages, featured posts, and recent posts.
- HTML pages advertise their Markdown versions with a `<link rel="alternate">` tag and an HTTP `Link` header.
- Markdown includes richer metadata and preserves Ghost image captions, bookmark descriptions, code blocks, and simple tables.
- Updated build dependencies and Dependabot coverage keep the project easier to maintain.

The worker helps clients find and read your content. `llms.txt` is a navigation aid, not a guarantee of search or AI ranking. Keep your HTML pages accessible to readers and crawlers too.

## Set up your blog

You need a Ghost blog, a Cloudflare account with its domain proxied (orange cloud), and Node.js 22 or later. The Worker route covers the whole domain; regular HTML requests pass through to Ghost with discovery links added.

1. **Get a Ghost Content API key.** In Ghost Admin, create a custom integration and copy its Content API key. The key reads published public content. Keep it out of Git and store it as a Wrangler secret.
2. **Install the project.**

   ~~~bash
   git clone https://github.com/matsbst/ghost-markdown-worker.git
   cd ghost-markdown-worker
   npm ci
   ~~~

3. **Set your domain in `wrangler.toml`.** The checked-in route points to `matsbs.com`. Replace it before deploying to another blog. You can also choose a different Worker `name`.

   ~~~toml
   routes = [{ pattern = "example.com/*", zone_name = "example.com" }]
   ~~~

   The domain must be in your Cloudflare account and its Ghost DNS record must be proxied. If Ghost's Content API is reachable at a different origin, set `GHOST_URL` to that origin; otherwise the Worker uses the public request origin.

4. **Log in, add the key, and deploy.**

   ~~~bash
   npx wrangler login
   npx wrangler secret put GHOST_API_KEY
   npm run deploy
   ~~~

   If you need a separate Ghost origin, run `npx wrangler secret put GHOST_URL` before deploying and enter its full URL, such as `https://ghost.example.com`.

5. **Check the result.** Replace `example.com` and the sample slug with your own.

   ~~~bash
   curl https://example.com/llms.txt
   curl https://example.com/notes/my-post.md
   curl -H 'Accept: text/markdown' https://example.com/notes/my-post/
   ~~~

Your existing HTML URL should still load normally. Its page source and response headers should point to the `.md` URL.

![Architecture diagram showing Markdown requests converted from the Ghost Content API and regular HTML requests passed through with discovery links.](docs/architecture.png)

## What the Worker publishes

### Markdown posts and pages

The Worker looks up a public Ghost post or page by slug, converts its HTML, and returns `text/markdown`. It keeps the article title and useful image context in the body. YAML frontmatter includes title, description, authors, language, publish and update dates, tags, canonical URL, content type, and feature image details.

~~~markdown
---
title: "My post"
description: "A short summary"
authors: ["Jane Doe"]
content_type: "post"
lang: "en"
date: "2026-10-18"
tags: ["ghost", "cloudflare"]
canonical_url: "https://example.com/notes/my-post/"
---

# My post

The article starts here.
~~~

Ghost image cards retain alt text and captions; bookmark cards retain their linked title and description. Fenced code blocks keep their language. Simple tables become GitHub-flavored Markdown tables; complex merged tables retain their HTML.

Only published, publicly accessible content is returned. The Worker verifies the Ghost content URL before serving a `.md` path, so a slug at a different path cannot be used to fetch the wrong page.

### `llms.txt` and discovery links

`/llms.txt` uses Ghost's site settings and Content API to list up to 25 public pages, 10 featured posts, and 25 recent posts. Duplicate entries are removed. Feature an enduring post in Ghost to keep it in the index after it leaves the recent list.

On eligible HTML posts and pages, the Worker adds a Markdown alternate in `<head>` and an HTTP `Link` header. It also links to `/llms.txt`. The homepage and collection pages link to `/llms.txt` without claiming to have a Markdown alternate. Ghost admin, assets, existing file paths, and pagination paths do not get Markdown alternates.

Markdown responses also link back to `/llms.txt`. Responses negotiated through `Accept` include `Vary: Accept`.

For search visibility, keep your site's `robots.txt` and Cloudflare bot rules aligned with the crawlers you want to allow. See [Google's guidance for generative AI Search](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide) and [OpenAI's crawler guidance](https://developers.openai.com/api/docs/bots).

### Caching

Successful Markdown and `llms.txt` responses are cached for five minutes at the Cloudflare edge. The cache is local to each data center, so a first request in a new region may still call Ghost. Change `MARKDOWN_CACHE_CONTROL` in `src/index.js` if you need another duration. No extra dashboard cache rule is required.

## Develop and maintain

For local development, put your own values in an ignored `.dev.vars` file:

~~~dotenv
GHOST_API_KEY=your_content_api_key_here
GHOST_URL=https://example.com
~~~

Then run `npm run dev` and visit `http://localhost:8787/llms.txt` or a `.md` URL. Never commit `.dev.vars`.

Before a pull request, run:

~~~bash
npm ci
npm test
npm run build
~~~

The tests use fixture responses in Miniflare. The build command is a deployment dry run. CI checks both on Node.js 22. Dependabot checks npm dependencies and GitHub Actions weekly; security updates are enabled for the repository.

The project vendors Turndown's non-browser build in `src/turndown.js` because the browser build needs DOM APIs unavailable in Workers. When updating Turndown, run `npm run vendor:turndown` and commit the generated file. Tests check that it matches the installed package. Keep `nodejs_compat` in `wrangler.toml`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `GHOST_API_KEY not configured` | Run `npx wrangler secret put GHOST_API_KEY` for this Worker. |
| A `.md` URL returns 404 | Confirm the post or page is published and its full path matches the Ghost URL. |
| The Worker does not run | Check that the DNS record is proxied and the `routes` entry matches the public domain. |
| Ghost API requests fail | Check `GHOST_URL` if Ghost uses a separate origin, then inspect `npx wrangler tail`. |
| `document is not defined` or error 1101 | Keep `src/turndown.js` and the `nodejs_compat` flag; do not import Turndown's browser build. |

## License

MIT
