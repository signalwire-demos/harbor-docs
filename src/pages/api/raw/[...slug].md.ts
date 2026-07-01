// /api/raw/[...slug].md — raw markdown SOURCE for each doc page.
//
// Why this exists: the DocsBot agent's RAG now runs on SignalWire DataSphere
// (hosted), which ingests documents BY URL and accepts only text/markdown |
// text/plain | application/pdf — it rejects rendered HTML (verified: pointing
// it at a rendered Starlight page returns `invalid_content_type`). This route
// serves each page's markdown source with a text/markdown content type so
// `agents/docs-bot/upload_index.py` can register every page in DataSphere by
// URL. It doubles as a plain "markdown for agents / llms.txt"-style endpoint.
//
// Mirrors api/catalog.json.ts: prerendered, reads the `docs` content
// collection, keyed by entry.id → /api/raw/concepts/destinations.md, etc.

import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

export const prerender = true;

export async function getStaticPaths() {
  const docs = await getCollection('docs');
  return docs.map((entry) => ({
    // entry.id e.g. "concepts/destinations" or "index"; strip any extension.
    params: { slug: entry.id.replace(/\.(md|mdx)$/, '') },
    props: {
      title: entry.data.title ?? '',
      body: entry.body ?? '',
    },
  }));
}

export const GET: APIRoute = async ({ props }) => {
  const { title, body } = props as { title: string; body: string };

  // Strip MDX plumbing that's pure noise for retrieval: import/export lines and
  // JSX component tags (keep their inner text). Frontmatter is already excluded
  // from entry.body by the content-collections loader. Single-line component
  // props only — a multi-line <Code ...props> would slip through; refine if the
  // corpus uses those heavily.
  const cleaned = (body ?? '')
    .replace(/^\s*(import|export)\s.+$/gm, '')
    .replace(/<\/?[A-Z][\w.]*(\s[^>]*)?\/?>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Lead with the title as an H1 so the chunker keeps the page name in-band
  // with the content (helps DataSphere relevance).
  const md = title ? `# ${title}\n\n${cleaned}\n` : `${cleaned}\n`;

  return new Response(md, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      'Access-Control-Allow-Origin': '*',
    },
  });
};
