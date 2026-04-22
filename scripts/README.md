# Harbor Docs — scripts

## `seed-docs.mjs`

Regenerates Harbor's doc corpus from `product.schema.json`.

```bash
# Dry-run — print plan without writing
node scripts/seed-docs.mjs --dry-run

# Regenerate all derivative pages (concepts, api, guides, troubleshooting, reference)
# Leaves hand-written pages (index, getting-started/*) alone.
node scripts/seed-docs.mjs

# Regenerate ONLY a specific kind
node scripts/seed-docs.mjs --only=concepts
node scripts/seed-docs.mjs --only=api,troubleshooting

# Overwrite hand-written pages too (rarely what you want)
node scripts/seed-docs.mjs --force-guides
```

### How it works

The script reads `product.schema.json` and walks `page_plan`. For each entry it
picks a template based on `kind` (`concept`, `api`, `guide`, `troubleshooting`,
`reference`) and generates deterministic MDX.

Hand-written pages — `index.mdx` and `getting-started/*.mdx` — are embedded in
the script as string templates. These are the narrative-heavy pages where
template output would feel flat, so the script just owns them directly.

### When to run

- You edited `product.schema.json` and want to regenerate.
- You forked the demo with a different product and want new docs from scratch.
- Never during CI (the output is committed to git).

### Adding new pages

1. Add an entry to `page_plan` in `product.schema.json`.
2. Add a matching entry to `concepts` / `endpoint_groups` / `guides` /
   `troubleshooting` / `reference_pages` depending on the `kind`.
3. If the `kind` is `guide` and you want code examples, add entries to
   `CODE_EXAMPLES` in `seed-docs.mjs` keyed by the guide's slug.
4. Re-run the script.

### Validation

The script does not validate internal links yet — if you change a concept slug,
search the repo for any MDX pages that link to it. Planned improvement:
post-seed link check against `getCollection('docs')`.
