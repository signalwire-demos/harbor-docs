#!/usr/bin/env node
// @ts-check
/**
 * seed-docs.mjs — Generate Harbor's Starlight MDX corpus from product.schema.json.
 *
 * Usage:
 *   node scripts/seed-docs.mjs              # regenerate all derivative pages
 *   node scripts/seed-docs.mjs --dry-run    # print plan without writing
 *   node scripts/seed-docs.mjs --only concepts,api    # regenerate a subset
 *
 * The script generates one MDX file per entry in product.schema.json's page_plan.
 * Home + getting-started + guides are hand-written and NOT overwritten by default —
 * pass --force-guides to regenerate those too (rarely what you want).
 *
 * Templates are deterministic and don't call any LLM. The output is
 * "consistent and realistic" rather than "polished marketing copy" — hand-polish
 * after regeneration if you care about the narrative voice.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SCHEMA_PATH = join(ROOT, 'product.schema.json');
const DOCS_DIR = join(ROOT, 'src', 'content', 'docs');

// ---------- CLI parsing ----------
const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const FORCE_GUIDES = args.has('--force-guides');
const ONLY = [...args]
  .find((a) => a.startsWith('--only='))
  ?.replace('--only=', '')
  ?.split(',');

// ---------- Load schema ----------
/** @type {any} */
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));

/**
 * Resolve a "source" path like "concepts.destinations" or
 * "endpoint_groups.destinations-api" into the actual object in the schema.
 */
function resolveSource(sourcePath) {
  if (!sourcePath) return null;
  const [collection, id] = sourcePath.split('.');
  const list = schema[collection];
  if (!Array.isArray(list)) return null;
  return list.find((item) => item.slug === id || item.id === id) ?? null;
}

// ---------- Helpers ----------
function mdxEscape(s) {
  return String(s ?? '').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

/**
 * Make a string MDX-safe for placement in prose / bullets.
 *
 * MDX treats `{...}` as JSX expressions and `<word>` as JSX elements. Any such
 * pattern outside a code span causes a parse error. We walk the string and
 * wrap these patterns in inline-code backticks when they appear outside an
 * existing backtick span. A state machine is needed because content like
 * `${foo}` (template literal inside an inline code span) is legal and should
 * be preserved as-is.
 */
function safeMdx(s) {
  const input = String(s ?? '');
  let out = '';
  let inCode = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '`') {
      inCode = !inCode;
      out += c;
      continue;
    }
    if (inCode) {
      out += c;
      continue;
    }
    if (c === '<') {
      // <word> / <word_word> / <word-word>: wrap in backticks.
      const close = input.indexOf('>', i + 1);
      if (close !== -1 && /^[\w][\w_-]*$/.test(input.slice(i + 1, close))) {
        out += '`' + input.slice(i, close + 1) + '`';
        i = close;
        continue;
      }
      // Stray `<` — escape to HTML entity so MDX leaves it alone.
      out += '&lt;';
      continue;
    }
    if (c === '{') {
      // Find the matching `}` (non-nested is fine for our content).
      const close = input.indexOf('}', i + 1);
      if (close !== -1) {
        out += '`' + input.slice(i, close + 1) + '`';
        i = close;
        continue;
      }
      out += '&#123;';
      continue;
    }
    out += c;
  }
  return out;
}

function frontmatter(title, description) {
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
  ].join('\n');
}

function bulletList(items) {
  return items.map((i) => `- ${safeMdx(i)}`).join('\n');
}

function conceptLink(slug) {
  const found = schema.concepts.find((c) => c.slug === slug);
  return found ? `[${found.title}](/concepts/${found.slug}/)` : `\`${slug}\``;
}

function endpointGroupLink(slug) {
  const found = schema.endpoint_groups.find((g) => g.slug === slug);
  if (!found) return `\`${slug}\``;
  // "destinations-api" → "/api/destinations/"
  const urlSlug = found.slug.replace(/-api$/, '');
  return `[${found.title}](/api/${urlSlug}/)`;
}

// ---------- Templates ----------

function renderConcept(concept) {
  const lines = [];
  lines.push(frontmatter(concept.title, concept.summary));
  lines.push(safeMdx(concept.explanation));
  lines.push('');
  if (concept.key_points?.length) {
    lines.push('## What to know');
    lines.push('');
    lines.push(bulletList(concept.key_points));
    lines.push('');
  }
  const related = [];
  if (concept.related_concepts?.length) {
    for (const s of concept.related_concepts) related.push(conceptLink(s));
  }
  if (concept.related_endpoints?.length) {
    for (const s of concept.related_endpoints) related.push(endpointGroupLink(s));
  }
  if (related.length) {
    lines.push('## Related');
    lines.push('');
    lines.push(bulletList(related));
    lines.push('');
  }
  return lines.join('\n');
}

function renderEndpointGroup(group) {
  const lines = [];
  lines.push(frontmatter(group.title, group.summary));
  lines.push(safeMdx(group.summary));
  lines.push('');
  if (group.concept) {
    lines.push(`See the ${conceptLink(group.concept)} concept for background.`);
    lines.push('');
  }

  for (const ep of group.endpoints) {
    lines.push(`## ${ep.title}`);
    lines.push('');
    lines.push(`\`${ep.method} ${ep.path}\``);
    lines.push('');
    lines.push(safeMdx(ep.summary));
    lines.push('');

    if (ep.params?.length) {
      lines.push('### Parameters');
      lines.push('');
      lines.push('| Name | Type | Required | Description |');
      lines.push('|------|------|----------|-------------|');
      for (const p of ep.params) {
        const req = p.required ? 'yes' : 'no';
        lines.push(`| \`${p.name}\` | ${p.type} | ${req} | ${mdxEscape(p.description ?? '')} |`);
      }
      lines.push('');
    }

    if (ep.returns) {
      lines.push('### Returns');
      lines.push('');
      lines.push(safeMdx(ep.returns));
      lines.push('');
    }

    lines.push('### Example');
    lines.push('');
    lines.push('```bash');
    lines.push(renderCurlExample(ep));
    lines.push('```');
    lines.push('');

    if (ep.errors?.length) {
      lines.push('### Errors');
      lines.push('');
      lines.push(bulletList(ep.errors.map((e) => `\`${e}\``)));
      lines.push('');
    }
  }
  return lines.join('\n');
}

function renderCurlExample(ep) {
  const base = schema.api.base_url;
  const method = ep.method.toUpperCase();
  const path = ep.path.replace(/\{id\}/g, 'dest_01HXYZ').replace(/\{delivery_id\}/g, 'del_01ABC');

  const lines = [`curl -X ${method} ${base}${path} \\`];
  lines.push(`  -H "Authorization: Bearer hk_live_your_api_key" \\`);
  if (method !== 'GET' && method !== 'DELETE') {
    lines.push(`  -H "Content-Type: application/json" \\`);
    const body = exampleBody(ep);
    if (body) {
      const bodyLines = JSON.stringify(body, null, 2).split('\n');
      lines.push(`  -d '${bodyLines.join('\n')}'`);
    } else {
      // trim trailing backslash
      lines[lines.length - 1] = lines[lines.length - 1].replace(/\s*\\$/, '');
    }
  } else {
    // trim trailing backslash on the last non-body line
    lines[lines.length - 1] = lines[lines.length - 1].replace(/\s*\\$/, '');
  }
  return lines.join('\n');
}

function exampleBody(ep) {
  const byId = {
    'create-destination': {
      url: 'https://api.example.com/webhooks/harbor',
      name: 'Production receiver',
      metadata: { owner: 'payments-team' },
    },
    'update-destination': { status: 'paused' },
    'create-subscription': {
      destination_id: 'dest_01HXYZ',
      event_type: 'order.*',
    },
    'events-create': {
      type: 'order.created',
      body: { order_id: 'ord_123', amount_cents: 4500 },
      idempotency_key: 'ord_123_created',
    },
    'events-replay': { destination_ids: ['dest_01HXYZ'] },
    'rotate-signing-key': { grace_period_days: 7 },
    'retry-delivery': null,
    'replay-dlq': null,
  };
  if (ep.id in byId) return byId[ep.id];
  return null;
}

function renderGuide(guide) {
  const lines = [];
  lines.push(frontmatter(guide.title, guide.intent));
  lines.push(safeMdx(`This guide walks through ${guide.intent.toLowerCase().replace(/\.$/, '')}.`));
  lines.push('');
  if (guide.key_points?.length) {
    lines.push('## What you need to know');
    lines.push('');
    lines.push(bulletList(guide.key_points));
    lines.push('');
  }
  const examples = CODE_EXAMPLES[guide.slug];
  if (examples) {
    lines.push('## Example');
    lines.push('');
    for (const [lang, code] of Object.entries(examples)) {
      lines.push(`### ${LANG_LABELS[lang] ?? lang}`);
      lines.push('');
      lines.push('```' + lang);
      lines.push(code.trim());
      lines.push('```');
      lines.push('');
    }
  }
  return lines.join('\n');
}

function renderTroubleshooting(entry) {
  const lines = [];
  lines.push(frontmatter(entry.title, `Troubleshooting: ${entry.title}.`));
  lines.push(safeMdx(`This page covers what "${entry.title.toLowerCase()}" usually means and how to recover.`));
  lines.push('');
  if (entry.symptoms?.length) {
    lines.push('## Symptoms');
    lines.push('');
    lines.push(bulletList(entry.symptoms));
    lines.push('');
  }
  if (entry.causes?.length) {
    lines.push('## What usually causes it');
    lines.push('');
    lines.push(bulletList(entry.causes));
    lines.push('');
  }
  if (entry.fixes?.length) {
    lines.push('## How to fix');
    lines.push('');
    lines.push(bulletList(entry.fixes));
    lines.push('');
  }
  return lines.join('\n');
}

function renderReference(ref) {
  const lines = [];
  lines.push(frontmatter(ref.title, ref.intent));
  lines.push(safeMdx(ref.intent));
  lines.push('');

  if (ref.slug === 'errors') {
    // Collect error codes from all endpoints.
    const seen = new Map();
    for (const group of schema.endpoint_groups) {
      for (const ep of group.endpoints) {
        for (const err of ep.errors ?? []) {
          if (!seen.has(err)) seen.set(err, []);
          seen.get(err).push(`${ep.method} ${ep.path}`);
        }
      }
    }
    lines.push('## Error codes');
    lines.push('');
    lines.push('| Code | Raised by |');
    lines.push('|------|-----------|');
    for (const [code, raisers] of [...seen].sort()) {
      lines.push(`| \`${code}\` | ${raisers.map((r) => `\`${r}\``).join(', ')} |`);
    }
    lines.push('');
    lines.push('All errors return a JSON body of the shape:');
    lines.push('');
    lines.push('```json');
    lines.push('{');
    lines.push('  "error": {');
    lines.push('    "code": "destination_not_found",');
    lines.push('    "message": "No destination with id dest_01HXYZ",');
    lines.push('    "request_id": "req_01J..."');
    lines.push('  }');
    lines.push('}');
    lines.push('```');
    lines.push('');
  } else if (ref.slug === 'rate-limits') {
    const rl = schema.api.rate_limit;
    lines.push('## Limits');
    lines.push('');
    lines.push(`- **Ingest**: ${rl.ingest}.`);
    lines.push(`- **Management API**: ${rl.management}.`);
    lines.push('');
    lines.push('## What happens when you hit them');
    lines.push('');
    lines.push([
      '- Ingest over-limit: Harbor returns `429 Too Many Requests` with a `Retry-After` header. Back off and retry.',
      '- Management over-limit: same `429` shape. Typically indicates an automation loop — check your deployment scripts.',
      '- Bursts are tolerated up to 3x the steady-state limit for 5 seconds.',
    ].join('\n'));
    lines.push('');
  } else if (ref.slug === 'webhooks-spec') {
    lines.push('## What Harbor sends');
    lines.push('');
    lines.push(bulletList(ref.key_points));
    lines.push('');
    lines.push('## Example request');
    lines.push('');
    lines.push('```http');
    lines.push('POST /webhooks/harbor HTTP/1.1');
    lines.push('Host: api.example.com');
    lines.push('Content-Type: application/json');
    lines.push('Harbor-Signature: t=1735689600,v1=a3b5c...');
    lines.push('Harbor-Event-Id: evt_01HXYZ');
    lines.push('Harbor-Event-Type: order.created');
    lines.push('Harbor-Delivery-Id: del_01ABC');
    lines.push('Harbor-Retry-Count: 0');
    lines.push('Harbor-Timestamp: 1735689600');
    lines.push('');
    lines.push('{"order_id": "ord_123", "amount_cents": 4500}');
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

// ---------- Code examples for guides ----------
const LANG_LABELS = {
  js: 'JavaScript (Node.js / Express)',
  node: 'JavaScript (Node.js / Express)',
  python: 'Python (Flask)',
  go: 'Go (net/http)',
  bash: 'Shell',
  curl: 'curl',
};

const CODE_EXAMPLES = {
  'verifying-signatures': {
    js: `
import express from 'express';
import crypto from 'node:crypto';

const app = express();
const SIGNING_SECRET = process.env.HARBOR_SIGNING_SECRET;

// IMPORTANT: express.raw — we need the raw bytes, not parsed JSON.
app.post('/webhooks/harbor', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.header('Harbor-Signature') || '';
  const [tPart, v1Part] = sig.split(',');
  const timestamp = tPart?.split('=')[1];
  const signature = v1Part?.split('=')[1];

  if (!timestamp || !signature) return res.sendStatus(401);
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return res.sendStatus(401);

  const expected = crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(timestamp + '.' + req.body.toString('utf8'))
    .digest('hex');

  const ok = crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  if (!ok) return res.sendStatus(401);

  const event = JSON.parse(req.body.toString('utf8'));
  // ... process event.type, event.body ...
  res.sendStatus(200);
});
`,
    python: `
import hmac, hashlib, time
from flask import Flask, request, abort

app = Flask(__name__)
SIGNING_SECRET = os.environ["HARBOR_SIGNING_SECRET"].encode()

@app.post("/webhooks/harbor")
def receive():
    sig = request.headers.get("Harbor-Signature", "")
    parts = dict(p.split("=", 1) for p in sig.split(",") if "=" in p)
    ts = parts.get("t")
    signature = parts.get("v1")
    if not ts or not signature:
        abort(401)
    if abs(time.time() - int(ts)) > 300:
        abort(401)

    body = request.get_data()  # raw bytes
    payload = f"{ts}.".encode() + body
    expected = hmac.new(SIGNING_SECRET, payload, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        abort(401)

    event = request.get_json()
    # ... process event["type"], event["body"] ...
    return "", 200
`,
    go: `
package main

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "io"
    "net/http"
    "os"
    "strconv"
    "strings"
    "time"
)

var signingSecret = []byte(os.Getenv("HARBOR_SIGNING_SECRET"))

func harborWebhook(w http.ResponseWriter, r *http.Request) {
    sig := r.Header.Get("Harbor-Signature")
    var ts, signature string
    for _, p := range strings.Split(sig, ",") {
        kv := strings.SplitN(p, "=", 2)
        if len(kv) != 2 { continue }
        if kv[0] == "t" { ts = kv[1] }
        if kv[0] == "v1" { signature = kv[1] }
    }
    if ts == "" || signature == "" { http.Error(w, "", 401); return }

    tsNum, _ := strconv.ParseInt(ts, 10, 64)
    if abs(time.Now().Unix() - tsNum) > 300 { http.Error(w, "", 401); return }

    body, _ := io.ReadAll(r.Body)
    mac := hmac.New(sha256.New, signingSecret)
    mac.Write([]byte(ts + "."))
    mac.Write(body)
    expected := hex.EncodeToString(mac.Sum(nil))
    expectedB, _ := hex.DecodeString(expected)
    signatureB, _ := hex.DecodeString(signature)
    if !hmac.Equal(expectedB, signatureB) { http.Error(w, "", 401); return }

    // ... process body ...
    w.WriteHeader(200)
}

func abs(x int64) int64 { if x < 0 { return -x }; return x }
`,
  },
  'handling-retries': {
    js: `
import express from 'express';
const app = express();

app.post('/webhooks/harbor', express.json(), async (req, res) => {
  // Ack fast — do NOT do expensive work on the hot path.
  try {
    await enqueueForAsyncWorker(req.body);   // durable queue, not in-memory
  } catch (err) {
    // Return 5xx so Harbor retries.
    return res.sendStatus(503);
  }
  // Once durably queued, ack. Even if our worker dies after this, the job is safe.
  res.sendStatus(200);
});

// Malformed event? 4xx (Harbor will dead-letter it immediately).
app.post('/webhooks/strict', express.json(), (req, res) => {
  if (!req.body?.type) return res.sendStatus(400);
  res.sendStatus(200);
});
`,
  },
  'idempotent-consumers': {
    python: `
import psycopg
# Table: CREATE TABLE seen_events (event_id text PRIMARY KEY, seen_at timestamptz DEFAULT now());

def process(event):
    event_id = event["event_id"]  # from Harbor-Event-Id header or event body
    with psycopg.connect(DB_URL) as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO seen_events (event_id) VALUES (%s) ON CONFLICT DO NOTHING RETURNING event_id",
            (event_id,),
        )
        inserted = cur.fetchone() is not None
    if not inserted:
        # Duplicate — Harbor retried a delivery we already handled.
        return
    do_actual_work(event)
`,
    go: `
// Assumes a unique constraint on seen_events.event_id.
func process(db *sql.DB, event Event) error {
    res, err := db.Exec(
        "INSERT INTO seen_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING",
        event.EventID,
    )
    if err != nil { return err }
    n, _ := res.RowsAffected()
    if n == 0 {
        return nil  // already processed
    }
    return doActualWork(event)
}
`,
  },
  'replaying-events': {
    curl: `
# 1. You have an event_id from your application log.
EVENT_ID=evt_01HXYZ

# 2. See what happened across all destinations.
curl https://api.harbor.example/v1/deliveries?event_id=$EVENT_ID \\
  -H "Authorization: Bearer hk_live_your_api_key"

# 3. The response shows three deliveries: two succeeded, one is dead.
DEAD_DELIVERY=del_01ABC

# 4. Look at the dead delivery's detail for the response body.
curl https://api.harbor.example/v1/deliveries/$DEAD_DELIVERY \\
  -H "Authorization: Bearer hk_live_your_api_key"

# 5. Customer fixed their side. Force a retry.
curl -X POST https://api.harbor.example/v1/deliveries/$DEAD_DELIVERY/retry \\
  -H "Authorization: Bearer hk_live_your_api_key"
`,
  },
  'local-testing': {
    bash: `
# 1. Install the CLI.
npm i -g @harbor/cli
harbor login              # opens a browser

# 2. Tunnel Harbor deliveries to your local server.
harbor listen --forward-to http://localhost:3000/webhooks/harbor
# → printed: "Listening on https://abc-123.harbor-tunnels.example"

# 3. In another terminal, register that URL as a test-mode destination.
curl -X POST https://api.harbor.example/v1/destinations \\
  -H "Authorization: Bearer hk_test_your_test_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://abc-123.harbor-tunnels.example","name":"Local dev"}'

# 4. Send a test event.
harbor events send --type order.created --body '{"order_id":"test_1"}'
`,
  },
};

// ---------- Hand-written pages (only written if they don't already exist,
// unless --force-guides is passed) ----------

const HAND_WRITTEN = {
  'index': {
    path: 'index.mdx',
    content: `---
title: Harbor
description: Reliable webhook delivery, with guardrails.
template: splash
hero:
  tagline: Reliable webhook delivery, with guardrails.
  actions:
    - text: Quickstart
      link: /getting-started/quickstart/
      icon: right-arrow
      variant: primary
    - text: API reference
      link: /api/destinations/
      variant: minimal
---

import { Card, CardGrid } from '@astrojs/starlight/components';

## What Harbor does

You POST events to Harbor. Harbor delivers them to your customers' HTTPS endpoints
with retries, HMAC signing, idempotency, replay, and a dead-letter queue. You don't
run the retry scheduler, you don't rotate signing keys by hand, and you don't lose
deliveries when a customer's endpoint has a bad five minutes.

<CardGrid>
  <Card title="Get started" icon="rocket">
    Send your first webhook in five minutes. See [Quickstart](/getting-started/quickstart/).
  </Card>
  <Card title="Core concepts" icon="document">
    [Destinations](/concepts/destinations/), [events](/concepts/events/), and
    [deliveries](/concepts/deliveries/) — the three nouns that explain everything.
  </Card>
  <Card title="API reference" icon="open-book">
    Every endpoint with parameters, returns, and \`curl\` examples.
    Start with [Destinations](/api/destinations/).
  </Card>
  <Card title="Troubleshooting" icon="warning">
    HMAC signature mismatches, retry storms, duplicate deliveries — the classics,
    with how to fix them. See [Troubleshooting](/troubleshooting/hmac-signature-mismatch/).
  </Card>
</CardGrid>
`,
  },
  'getting-started/install': {
    path: 'getting-started/install.mdx',
    content: `---
title: Install
description: Get Harbor's CLI and an API key.
---

Harbor is an API. You interact with it three ways: curl, any HTTP client, or the
\`harbor\` CLI (useful for local development and scripting).

## 1. Get an API key

Sign up at [harbor.example](https://harbor.example) and create a project. In the
project dashboard, create a **live** and a **test** API key. Live keys start with
\`hk_live_\`, test keys start with \`hk_test_\`. Store them in your secret manager —
there is no way to retrieve a lost key, only to rotate it.

## 2. Install the CLI (optional)

\`\`\`bash
npm i -g @harbor/cli
harbor login
\`\`\`

The CLI is not required — it just makes local development less painful by
tunneling deliveries to your laptop. See [Local testing](/guides/local-testing/).

## 3. Verify

\`\`\`bash
curl https://api.harbor.example/v1/destinations \\
  -H "Authorization: Bearer hk_test_your_test_key"
\`\`\`

You should get back an empty paginated response:

\`\`\`json
{ "data": [], "next_cursor": null }
\`\`\`

If you get a \`401\`, the key is wrong or you forgot the \`Bearer\` prefix. If you
get a \`403\`, the key is for a different project or environment.

Next: send your first webhook in the [Quickstart](/getting-started/quickstart/).
`,
  },
  'getting-started/quickstart': {
    path: 'getting-started/quickstart.mdx',
    content: `---
title: Quickstart
description: Send your first webhook end-to-end in five minutes.
---

This walks you through creating a destination, subscribing to an event type,
sending an event, and watching the delivery land. You'll use test mode so
nothing touches real customers.

## 1. Pick an endpoint to receive webhooks

For this quickstart, use a disposable receiver. Open
[webhook.site](https://webhook.site) in another tab and copy the unique URL it
gives you. This is what Harbor will POST to.

## 2. Register the destination

\`\`\`bash
curl -X POST https://api.harbor.example/v1/destinations \\
  -H "Authorization: Bearer hk_test_your_test_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://webhook.site/your-unique-id",
    "name": "Quickstart receiver"
  }'
\`\`\`

The response includes the destination's \`id\` (\`dest_...\`) and its
\`signing_secret\` — this is shown **once**. Save it; you'll need it to verify
payloads in a real receiver. See [Signing & verification](/concepts/signing-verification/).

## 3. Subscribe to an event type

\`\`\`bash
curl -X POST https://api.harbor.example/v1/subscriptions \\
  -H "Authorization: Bearer hk_test_your_test_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "destination_id": "dest_01HXYZ",
    "event_type": "order.created"
  }'
\`\`\`

## 4. Send an event

\`\`\`bash
curl -X POST https://api.harbor.example/v1/events \\
  -H "Authorization: Bearer hk_test_your_test_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "type": "order.created",
    "body": { "order_id": "ord_123", "amount_cents": 4500 }
  }'
\`\`\`

## 5. Watch the delivery

Refresh webhook.site — you should see a POST with the event body and a
\`Harbor-Signature\` header. Meanwhile:

\`\`\`bash
curl https://api.harbor.example/v1/deliveries \\
  -H "Authorization: Bearer hk_test_your_test_key"
\`\`\`

One delivery, status \`succeeded\`, \`response_code: 200\`.

That's the whole loop. From here:

- [Verify signatures](/guides/verifying-signatures/) in a real receiver.
- [Handle retries](/guides/handling-retries/) correctly so Harbor's retry
  behavior matches what your endpoint expects.
- [Build idempotent consumers](/guides/idempotent-consumers/) so retries don't
  double-process.
`,
  },
};

// ---------- Main ----------

function planForPage(p) {
  const kind = p.kind;
  if (kind === 'home') return { hand: 'index' };
  if (kind === 'getting-started') return { hand: p.slug };
  const source = resolveSource(p.source);
  if (!source) return { skip: true, reason: `no source for ${p.source}` };
  return { render: { kind, source } };
}

function renderPage(plan) {
  switch (plan.render.kind) {
    case 'concept':
      return renderConcept(plan.render.source);
    case 'api':
      return renderEndpointGroup(plan.render.source);
    case 'guide':
      return renderGuide(plan.render.source);
    case 'troubleshooting':
      return renderTroubleshooting(plan.render.source);
    case 'reference':
      return renderReference(plan.render.source);
    default:
      return null;
  }
}

function shouldRun(kind) {
  if (!ONLY || ONLY.length === 0) return true;
  return ONLY.includes(kind) || ONLY.includes('all');
}

let written = 0;
let skipped = 0;

for (const page of schema.page_plan) {
  if (!shouldRun(page.kind)) continue;

  const target = join(DOCS_DIR, `${page.slug}.mdx`);
  const plan = planForPage(page);

  if (plan.skip) {
    console.log(`SKIP ${page.slug}  (${plan.reason})`);
    skipped++;
    continue;
  }

  let content;
  if (plan.hand) {
    const entry = HAND_WRITTEN[plan.hand];
    if (!entry) {
      console.log(`SKIP ${page.slug}  (no hand-written template: ${plan.hand})`);
      skipped++;
      continue;
    }
    if (existsSync(target) && !FORCE_GUIDES) {
      console.log(`KEEP ${page.slug}  (hand-written; use --force-guides to overwrite)`);
      skipped++;
      continue;
    }
    content = entry.content;
  } else {
    content = renderPage(plan);
    if (!content) {
      console.log(`SKIP ${page.slug}  (no renderer for kind ${page.kind})`);
      skipped++;
      continue;
    }
  }

  if (DRY_RUN) {
    console.log(`PLAN ${page.slug}  (${content.length} bytes)`);
    written++;
    continue;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf-8');
  console.log(`WRITE ${page.slug}`);
  written++;
}

console.log(`\nDone. ${written} pages ${DRY_RUN ? 'planned' : 'written'}, ${skipped} skipped.`);
