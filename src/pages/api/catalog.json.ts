// /api/catalog.json — the catalog the DocsBot agent reads at construction.
//
// Returns a denormalized list of every published doc page with its slug,
// title, short description, kind (concept/api/guide/troubleshooting/reference),
// and all H2/H3 heading anchors. The agent renders this into a POM section so
// the LLM knows the exact slug to pass to `navigate` and the exact anchor to
// pass to `scroll_to`.
//
// Why static? The catalog only changes when doc content changes, i.e., on
// build. Pre-rendering means the agent can fetch it from any hosting without
// needing SSR.

import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

export const prerender = true;

export const GET: APIRoute = async () => {
  const docs = await getCollection('docs');

  const pages = docs
    .map((entry) => {
      // entry.id is the file path relative to src/content/docs, without extension
      // e.g., "concepts/destinations" or "index"
      const slug = entry.id === 'index' ? '' : entry.id.replace(/\.(md|mdx)$/, '');
      const kind = inferKind(slug);

      // Extract visible headings from the MDX AST. Starlight exposes headings
      // via entry.rendered?.metadata.headings in some versions, but the
      // content-collections API has shifted. Use a simple regex fallback on
      // the body so we don't depend on internal shape.
      const headings = extractHeadings(entry.body ?? '');

      return {
        slug,
        title: entry.data.title,
        description: entry.data.description ?? '',
        kind,
        headings,
      };
    })
    // Stable ordering: home first, then by slug depth + alpha.
    .sort((a, b) => {
      if (a.slug === '' ) return -1;
      if (b.slug === '') return 1;
      return a.slug.localeCompare(b.slug);
    });

  return new Response(JSON.stringify({ pages }, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
      // CORS is wide-open because this is static public data and the agent
      // fetches it server-side anyway. Widen/tighten if you front the site
      // with auth.
      'Access-Control-Allow-Origin': '*',
    },
  });
};

function inferKind(slug: string): string {
  if (slug === '') return 'home';
  if (slug.startsWith('getting-started/')) return 'getting-started';
  if (slug.startsWith('concepts/')) return 'concept';
  if (slug.startsWith('api/')) return 'api';
  if (slug.startsWith('guides/')) return 'guide';
  if (slug.startsWith('troubleshooting/')) return 'troubleshooting';
  if (slug.startsWith('reference/')) return 'reference';
  return 'other';
}

/**
 * Pull H2/H3 headings and their slugified anchors out of the raw markdown.
 * This matches Starlight's default heading-id generation (lowercase, hyphens,
 * strip non-alphanumeric). Good enough for navigation — if a page uses a
 * custom heading id via `{#id}` we'd need a richer parser.
 */
function extractHeadings(body: string): { depth: number; text: string; id: string }[] {
  const out: { depth: number; text: string; id: string }[] = [];
  const lines = body.split('\n');
  let inCodeFence = false;
  for (const line of lines) {
    if (line.startsWith('```')) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    const m = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    if (!m) continue;
    const depth = m[1].length;
    const text = m[2].replace(/[`*_]/g, '').trim();
    const id = slugify(text);
    out.push({ depth, text, id });
  }
  return out;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}
