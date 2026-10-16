// Import local copy of non-browser Turndown (browser build needs native DOM)
import TurndownService from './turndown.js';

const LLMS_POST_LIMIT = 25;
const LLMS_FEATURED_LIMIT = 10;
const LLMS_PAGE_LIMIT = 25;
const MARKDOWN_CONTENT_TYPE = 'text/markdown; charset=utf-8';
const MARKDOWN_CACHE_CONTROL = 'public, max-age=300, s-maxage=300';
const MARKDOWN_CACHE_BUSTER = '__gmw_repr=markdown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

// Convert Ghost image cards
turndown.addRule('ghostImage', {
  filter(node) {
    return node.nodeName === 'FIGURE' && node.classList.contains('kg-image-card');
  },
  replacement(content, node) {
    const img = node.querySelector('img');
    const figcaption = node.querySelector('figcaption');
    if (!img) return content;
    const alt = img.alt || '';
    const src = img.getAttribute('src') || '';
    const caption = figcaption?.textContent.trim();
    return `\n\n![${escapeMarkdownInline(alt)}](${escapeMarkdownUrl(src)})${caption ? `\n\n*${escapeMarkdownInline(caption)}*` : ''}\n\n`;
  },
});

// Convert Ghost bookmark cards
turndown.addRule('ghostBookmark', {
  filter(node) {
    return node.nodeName === 'FIGURE' && node.classList.contains('kg-bookmark-card');
  },
  replacement(content, node) {
    const link = node.querySelector('a.kg-bookmark-container');
    const title = node.querySelector('.kg-bookmark-title');
    const description = node.querySelector('.kg-bookmark-description');
    if (!link) return content;
    const href = link.getAttribute('href') || '';
    const text = title ? title.textContent.trim() : href;
    const summary = description?.textContent.trim();
    return `\n\n[${escapeMarkdownInline(text)}](${escapeMarkdownUrl(href)})${summary ? ` — ${escapeMarkdownInline(summary)}` : ''}\n\n`;
  },
});

// Turndown does not convert tables by default. Preserve simple tables as GFM.
turndown.addRule('table', {
  filter: 'table',
  replacement(content, node) {
    const rows = Array.from(node.querySelectorAll('tr')).map((row) =>
      Array.from(row.children).filter((cell) => cell.nodeName === 'TH' || cell.nodeName === 'TD')
    );
    const width = rows[0]?.length || 0;
    if (!width || node.querySelector('table') || rows.some((row) =>
      row.length !== width || row.some((cell) => cell.hasAttribute('rowspan') || cell.hasAttribute('colspan'))
    )) {
      return `\n\n${node.outerHTML}\n\n`;
    }

    const renderRow = (row) => `| ${row.map((cell) =>
      turndown.turndown(cell.innerHTML).replace(/\n+/g, '<br>').replace(/\|/g, '\\|')
    ).join(' | ')} |`;
    return `\n\n${[renderRow(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(renderRow)].join('\n')}\n\n`;
  },
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/llms.txt') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', {
          status: 405,
          headers: { 'Allow': 'GET, HEAD' },
        });
      }

      return handleLlmsTxtRequest(request, url, env, ctx);
    }

    const requestMode = classifyRequest(request, url);
    if (requestMode.kind === 'markdown') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', {
          status: 405,
          headers: { 'Allow': 'GET, HEAD' },
        });
      }

      return handleMarkdownRequest(request, url, env, ctx, requestMode);
    }

    return handleHtmlPassthrough(request, url);
  },
};

async function handleLlmsTxtRequest(request, url, env, ctx) {
  const ghostApiKey = env.GHOST_API_KEY;
  const ghostUrl = env.GHOST_URL || url.origin;

  if (!ghostApiKey) {
    return new Response('GHOST_API_KEY not configured', { status: 500 });
  }

  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const cache = caches.default;
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    return asHeadResponseIfNeeded(request, cachedResponse);
  }

  const [settings, pages, featured, posts] = await Promise.all([
    fetchGhostJson(
      `${ghostUrl}/ghost/api/content/settings/?key=${ghostApiKey}`,
      '/llms.txt',
      'Ghost settings'
    ),
    fetchGhostJson(
      `${ghostUrl}/ghost/api/content/pages/?key=${ghostApiKey}&limit=${LLMS_PAGE_LIMIT}`,
      '/llms.txt',
      'Ghost page index'
    ),
    fetchGhostJson(
      `${ghostUrl}/ghost/api/content/posts/?key=${ghostApiKey}&filter=featured:true&limit=${LLMS_FEATURED_LIMIT}`,
      '/llms.txt',
      'Ghost featured post index'
    ),
    fetchGhostJson(
      `${ghostUrl}/ghost/api/content/posts/?key=${ghostApiKey}&limit=${LLMS_POST_LIMIT}`,
      '/llms.txt',
      'Ghost post index'
    ),
  ]);

  if (settings.error) {
    return settings.error;
  }

  for (const result of [pages, featured, posts]) {
    if (result.error) return result.error;
  }

  const site = settings.data.settings || {};
  const siteTitle = site.title || url.hostname;
  const siteDescription = site.description || `Published Ghost posts from ${url.hostname}`;

  const lines = [
    `# ${escapeMarkdownInline(sanitizeText(siteTitle))}`,
    '',
    `> ${escapeMarkdownInline(sanitizeText(siteDescription))}`,
    '',
    'Published posts and pages are available as Markdown at the linked `.md` URLs or with `Accept: text/markdown` on their HTML URLs.',
  ];

  const seen = new Set();
  appendLlmsSection(lines, 'Pages', pages.data.pages || [], url.origin, seen);
  appendLlmsSection(lines, 'Featured posts', featured.data.posts || [], url.origin, seen);
  appendLlmsSection(lines, 'Recent posts', posts.data.posts || [], url.origin, seen);
  if (seen.size === 0) {
    lines.push('', 'No public posts or pages were returned by the Ghost Content API.');
  }

  const response = new Response(`${lines.join('\n')}\n`, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': MARKDOWN_CACHE_CONTROL,
    },
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return asHeadResponseIfNeeded(request, response);
}

async function handleMarkdownRequest(request, url, env, ctx, requestMode) {
  const pathSegments = requestMode.htmlPath.split('/');
  const slug = pathSegments[pathSegments.length - 1];

  if (!slug) {
    return new Response('Missing slug', { status: 400 });
  }

  const ghostApiKey = env.GHOST_API_KEY;
  const ghostUrl = env.GHOST_URL || url.origin;

  if (!ghostApiKey) {
    return new Response('GHOST_API_KEY not configured', { status: 500 });
  }

  const cache = caches.default;
  const cacheKey = createMarkdownCacheKey(url, requestMode.htmlPath);
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    return asHeadResponseIfNeeded(request, cachedResponse);
  }

  let post;
  let contentType;
  for (const resource of ['posts', 'pages']) {
    const result = await fetchGhostJson(
      `${ghostUrl}/ghost/api/content/${resource}/slug/${slug}/?key=${ghostApiKey}&formats=html&include=authors,tags`,
      url.pathname,
      `Ghost ${resource} lookup`
    );
    if (result.error) {
      if (result.status === 404) continue;
      return result.error;
    }

    const candidate = result.data[resource]?.[0];
    if (!candidate) continue;
    try {
      const candidatePath = normalizePathname(new URL(candidate.url || `${url.origin}${requestMode.htmlPath}/`).pathname);
      if (candidatePath !== requestMode.htmlPath) continue;
    } catch (err) {
      console.error('Invalid Ghost content URL', { path: url.pathname, error: formatError(err) });
      return new Response('Invalid content URL', { status: 502 });
    }

    post = candidate;
    contentType = resource === 'posts' ? 'post' : 'page';
    break;
  }

  if (!post || post.access === false || post.html == null) {
    return new Response(`Public content not found: ${slug}`, { status: 404 });
  }

  const settingsResult = await fetchGhostJson(
    `${ghostUrl}/ghost/api/content/settings/?key=${ghostApiKey}`,
    url.pathname,
    'Ghost settings'
  );

  const settings = settingsResult.error ? null : settingsResult.data.settings || null;
  const tags = (post.tags || []).map((tag) => tag.name);
  const publishedDate = post.published_at ? post.published_at.split('T')[0] : '';
  const description = post.meta_description || post.custom_excerpt || post.excerpt || '';
  const author = post.primary_author?.name || '';
  const authors = (post.authors || (post.primary_author ? [post.primary_author] : [])).map((item) => item.name);
  const lang = settings?.lang || '';
  const canonicalUrl = post.canonical_url || `${url.origin}${requestMode.htmlPath}/`;

  const frontmatter = [
    '---',
    `title: "${escapeYaml(post.title)}"`,
    `slug: "${escapeYaml(post.slug || '')}"`,
    `description: "${escapeYaml(description)}"`,
    `author: "${escapeYaml(author)}"`,
    `authors: [${authors.map((name) => `"${escapeYaml(name)}"`).join(', ')}]`,
    `content_type: "${contentType}"`,
    `lang: "${escapeYaml(lang)}"`,
    `date: ${publishedDate ? `"${escapeYaml(publishedDate)}"` : '""'}`,
    `published_at: "${escapeYaml(post.published_at || '')}"`,
    `updated_at: "${escapeYaml(post.updated_at || '')}"`,
    `feature_image: "${escapeYaml(post.feature_image || '')}"`,
    `feature_image_alt: "${escapeYaml(post.feature_image_alt || '')}"`,
    `feature_image_caption: "${escapeYaml(post.feature_image_caption || '')}"`,
    `tags: [${tags.map((tag) => `"${escapeYaml(tag)}"`).join(', ')}]`,
    `canonical_url: "${escapeYaml(canonicalUrl)}"`,
    '---',
  ].join('\n');

  const markdown = turndown.turndown(post.html).trim();
  const heading = /^#\s/m.test(markdown) ? '' : `# ${escapeMarkdownInline(sanitizeText(post.title))}`;
  const featureImage = post.feature_image && !post.html.includes(post.feature_image)
    ? `![${escapeMarkdownInline(post.feature_image_alt || '')}](${escapeMarkdownUrl(post.feature_image)})${post.feature_image_caption ? `\n\n*${escapeMarkdownInline(post.feature_image_caption)}*` : ''}`
    : '';
  const body = `${frontmatter}\n\n${[heading, featureImage, markdown].filter(Boolean).join('\n\n')}\n`;
  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': MARKDOWN_CONTENT_TYPE,
      'Cache-Control': MARKDOWN_CACHE_CONTROL,
      'Vary': 'Accept',
      'Link': `<${url.origin}/llms.txt>; rel="describedby"`,
    },
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return asHeadResponseIfNeeded(request, response);
}

async function handleHtmlPassthrough(request, url) {
  let response;
  try {
    response = await fetch(request);
  } catch (err) {
    console.error('Origin fetch failed', {
      path: url.pathname,
      error: formatError(err),
    });
    return new Response('Upstream unavailable', { status: 502 });
  }

  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || !contentType.includes('text/html')) {
    return response;
  }

  const mdUrl = buildMdUrl(url);
  if (/^\/(?:ghost|assets|content)(?:\/|$)/.test(url.pathname)) {
    return response;
  }

  if (request.method === 'HEAD') {
    return addDiscoveryHeaders(response, mdUrl, url.origin);
  }

  const rewritten = new HTMLRewriter()
    .on('head', {
      element(element) {
        if (mdUrl) {
          element.append(
            `<link rel="alternate" type="text/markdown" href="${mdUrl}" />`,
            { html: true }
          );
        }
        element.append(
          `<link rel="describedby" href="${url.origin}/llms.txt" />`,
          { html: true }
        );
      },
    })
    .transform(response);

  return addDiscoveryHeaders(rewritten, mdUrl, url.origin);
}

function classifyRequest(request, url) {
  if (url.pathname.endsWith('.md')) {
    return {
      kind: 'markdown',
      htmlPath: buildHtmlPathFromMarkdownPath(url.pathname),
    };
  }

  if (acceptsMarkdown(request.headers.get('Accept')) && buildMdUrl(url)) {
    return {
      kind: 'markdown',
      htmlPath: normalizePathname(url.pathname),
    };
  }

  return { kind: 'html' };
}

function buildHtmlPathFromMarkdownPath(pathname) {
  return normalizePathname(pathname.replace(/\.md$/, ''));
}

function buildMdUrl(url) {
  let path = url.pathname;

  if (path.endsWith('/') && path.length > 1) {
    path = path.slice(0, -1);
  }

  if (path === '/' || path === '') {
    return null;
  }

  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  const firstSegment = segments[0];
  const lastSegment = segments[segments.length - 1];

  if (
    firstSegment === 'ghost' ||
    firstSegment === 'assets' ||
    firstSegment === 'content' ||
    path.match(/\.\w+$/) ||
    lastSegment === 'rss'
  ) {
    return null;
  }

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1];

    if ((segment === 'tag' || segment === 'author') && nextSegment) {
      return null;
    }

    if (segment === 'page' && nextSegment && /^\d+$/.test(nextSegment)) {
      return null;
    }
  }

  return `${url.origin}${path}.md`;
}

function createMarkdownCacheKey(url, htmlPath) {
  const cacheUrl = new URL(url.toString());
  cacheUrl.pathname = htmlPath;
  cacheUrl.search = `?${MARKDOWN_CACHE_BUSTER}`;
  cacheUrl.hash = '';
  return new Request(cacheUrl.toString(), { method: 'GET' });
}

function addDiscoveryHeaders(response, mdUrl, origin) {
  const headers = new Headers(response.headers);
  if (mdUrl) {
    headers.append('Link', `<${mdUrl}>; rel="alternate"; type="text/markdown"`);
    addVaryValue(headers, 'Accept');
  }
  headers.append('Link', `<${origin}/llms.txt>; rel="describedby"`);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function addVaryValue(headers, value) {
  const vary = headers.get('Vary');
  if (!vary) {
    headers.set('Vary', value);
    return;
  }

  const existing = vary
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  if (!existing.includes(value.toLowerCase())) {
    headers.set('Vary', `${vary}, ${value}`);
  }
}

function normalizePathname(pathname) {
  if (!pathname || pathname === '/') {
    return '/';
  }

  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function acceptsMarkdown(acceptHeader) {
  if (!acceptHeader) {
    return false;
  }

  return acceptHeader
    .split(',')
    .map((part) => part.trim())
    .some((part) => {
      const [mediaType, ...params] = part.split(';').map((item) => item.trim());
      if (mediaType.toLowerCase() !== 'text/markdown') {
        return false;
      }

      const qParam = params.find((param) => param.toLowerCase().startsWith('q='));
      if (!qParam) {
        return true;
      }

      const qValue = Number.parseFloat(qParam.slice(2));
      return Number.isFinite(qValue) && qValue > 0;
    });
}

function escapeYaml(str) {
  if (!str) return '';
  return str
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/"/g, '\\"');
}

async function fetchGhostJson(apiUrl, requestPath, targetName) {
  let apiResponse;

  try {
    apiResponse = await fetch(apiUrl, {
      headers: { 'Accept': 'application/json' },
    });
  } catch (err) {
    console.error(`${targetName} fetch failed`, {
      path: requestPath,
      error: formatError(err),
    });
    return {
      error: new Response('Upstream unavailable', { status: 502 }),
      status: 502,
    };
  }

  if (!apiResponse.ok) {
    return {
      error: new Response(`${targetName} error: ${apiResponse.status}`, { status: apiResponse.status }),
      status: apiResponse.status,
    };
  }

  return {
    data: await apiResponse.json(),
    status: apiResponse.status,
  };
}

function asHeadResponseIfNeeded(request, response) {
  if (request.method !== 'HEAD') {
    return response;
  }

  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function formatError(err) {
  return err instanceof Error ? err.message : String(err);
}

function buildMarkdownUrlForEntry(entry, publicOrigin) {
  const entryUrl = entry.url || `${publicOrigin}/${entry.slug}/`;

  try {
    const parsedUrl = new URL(entryUrl);
    return buildMarkdownUrlFromPath(parsedUrl.pathname, publicOrigin);
  } catch {
    return null;
  }
}

function buildMarkdownUrlFromPath(pathname, origin) {
  const normalizedPath = normalizePathname(pathname);
  if (normalizedPath === '/') {
    return null;
  }

  const publicUrl = new URL(origin);
  publicUrl.pathname = normalizedPath;
  return buildMdUrl(publicUrl);
}

function sanitizeText(str) {
  return String(str).replace(/\s+/g, ' ').trim();
}

function escapeMarkdownInline(str) {
  return sanitizeText(str).replace(/([\\`*_{}\[\]<>!#])/g, '\\$1');
}

function escapeMarkdownUrl(str) {
  return String(str).replace(/\\/g, '%5C').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20');
}

function appendLlmsSection(lines, title, entries, publicOrigin, seen) {
  const links = [];
  for (const entry of entries) {
    if (entry.access === false || (entry.html == null) || (!entry.html && !entry.feature_image)) continue;
    const markdownUrl = buildMarkdownUrlForEntry(entry, publicOrigin);
    if (!markdownUrl || seen.has(markdownUrl)) continue;

    seen.add(markdownUrl);
    const summary = entry.custom_excerpt || entry.excerpt;
    links.push(`- [${escapeMarkdownInline(entry.title || entry.slug)}](${escapeMarkdownUrl(markdownUrl)})${summary ? `: ${escapeMarkdownInline(summary)}` : ''}`);
  }

  if (links.length) lines.push('', `## ${title}`, '', ...links);
}
