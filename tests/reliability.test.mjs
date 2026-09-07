import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../dist/server.js', import.meta.url));
const id = (prefix, letter = 'a') => `${prefix}_${letter.repeat(24)}`;
const data = (reply) => JSON.parse(reply.content[0].text);
const syntheticKey = 'ac_live_' + 'k'.repeat(43);
async function fixture(handler, run, key) {
  const state = await mkdtemp(join(tmpdir(), 'agentcommons-reliability-'));
  const http = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    try {
      await handler(req, res, raw ? JSON.parse(raw) : undefined);
    } catch (error) {
      res
        .writeHead(500)
        .end(JSON.stringify({ error: { code: 'fixture_failure', message: error.message } }));
    }
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'reliability-contract-test', version: '1.0.0' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [entry],
        env: {
          AGENTCOMMONS_URL: `http://127.0.0.1:${http.address().port}`,
          AGENTCOMMONS_STATE_DIR: state,
          ...(key ? { AGENTCOMMONS_API_KEY: key } : {}),
        },
      }),
    );
    await run((name, args = {}) => client.callTool({ name, arguments: args }), client);
  } finally {
    await client.close();
    await new Promise((resolve) => http.close(resolve));
    await rm(state, { recursive: true, force: true });
  }
}

test('MCP preserves pagination and applicable filters, task reads and author resolution', async () => {
  const paths = [];
  await fixture(
    (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      paths.push(url);
      if (req.method === 'GET') assert.equal(req.headers.authorization, undefined);
      if (url.pathname.endsWith('/resolve')) {
        assert.equal(req.headers.authorization, `Bearer ${syntheticKey}`);
        res.end(JSON.stringify({ id: id('msg'), resolved_at: '2026-09-07T00:00:00Z' }));
        return;
      }
      const cursor = Number(url.searchParams.get('cursor') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 20);
      res.end(
        JSON.stringify({
          items: Array.from({ length: Math.min(limit, 45 - cursor) }, (_, i) => ({
            id: String(cursor + i),
          })),
          next_cursor: cursor + limit < 45 ? String(cursor + limit) : null,
        }),
      );
    },
    async (call, client) => {
      for (const [name, args] of [
        ['search', { q: 'known topic', channel: 'general', agent: id('agt'), type: 'HELP' }],
        [
          'read_feed',
          {
            task_id: id('task'),
            reply_to: id('msg'),
            to: id('agt'),
            page_id: id('page'),
            unresolved: 'true',
            since: '2026-09-01T00:00:00Z',
          },
        ],
        ['get_inbox', { id: id('agt'), type: 'ANSWER' }],
        ['list_tasks', { channel: 'general', agent: id('agt') }],
      ]) {
        const seen = [],
          usedCursors = new Set();
        let cursor;
        do {
          const response = await call(name, { ...args, limit: 20, ...(cursor ? { cursor } : {}) });
          assert.equal(response.isError, false);
          const page = data(response);
          seen.push(...page.items.map((item) => item.id));
          cursor = page.next_cursor;
          if (cursor) {
            assert.ok(!usedCursors.has(cursor));
            usedCursors.add(cursor);
          }
        } while (cursor);
        assert.equal(seen.length, 45);
        assert.equal(new Set(seen).size, 45);
        assert.equal(usedCursors.size, 2);
      }
      assert.equal(paths[0].searchParams.get('q'), 'known topic');
      assert.equal(paths[3].searchParams.get('task_id'), id('task'));
      assert.equal(paths[3].searchParams.get('reply_to'), id('msg'));
      assert.equal(paths[3].searchParams.get('since'), '2026-09-01T00:00:00Z');
      assert.equal(paths[6].pathname, `/api/v1/agents/${id('agt')}/inbox`);
      assert.equal(paths[6].searchParams.has('id'), false);
      await call('read_task', { id: id('task') });
      assert.equal(paths.at(-1).pathname, `/api/v1/tasks/${id('task')}`);
      await call('read_changes', { after: '42', channel: 'general', limit: 80 });
      assert.equal(paths.at(-1).search, '?after=42&channel=general&limit=80');
      const resolved = await call('resolve_message', {
        id: id('msg'),
        idempotency_key: 'resolve-question-intent',
      });
      assert.ok(data(resolved).resolved_at);
      const tools = (await client.listTools()).tools;
      assert.equal(
        tools.find((tool) => tool.name === 'resolve_message').annotations.readOnlyHint,
        false,
      );
      assert.equal(tools.find((tool) => tool.name === 'read_task').annotations.readOnlyHint, true);
    },
    syntheticKey,
  );
});

test('HTTP metadata remains machine-readable and visible to text clients; a lost write keeps its exact retry intent', async () => {
  let lostAttempts = 0;
  const received = [];
  await fixture(
    (req, res, body) => {
      const subject = body.subject;
      if (subject === 'lost') {
        received.push({ intent: req.headers['idempotency-key'], body });
        if (++lostAttempts === 1) {
          req.socket.destroy();
          return;
        }
        res.setHeader('Idempotency-Replayed', 'true');
        res.writeHead(201).end(JSON.stringify({ id: id('msg') }));
        return;
      }
      const status = Number(subject);
      res.setHeader('X-Request-Id', `request-${status}`);
      if (status === 429) res.setHeader('Retry-After', '73');
      res.writeHead(status).end(
        JSON.stringify({
          error: {
            code: status === 429 ? 'rate_limited' : 'conflict',
            message: 'Fixture response',
          },
        }),
      );
    },
    async (call) => {
      for (const status of [429, 409, 500]) {
        const response = await call('post_message', {
          subject: String(status),
          body: 'Fixture',
          idempotency_key: `status-${status}-intent`,
        });
        assert.equal(response.isError, true);
        assert.equal(response.structuredContent.status, status);
        assert.equal(response.structuredContent.request_id, `request-${status}`);
        assert.equal(JSON.parse(response.content[1].text).response.status, status);
        if (status === 429) {
          assert.equal(response.structuredContent.retry_after_seconds, 73);
          assert.match(response.content[1].text, /73/);
        }
      }
      const args = {
        subject: 'lost',
        body: 'Exact operation',
        idempotency_key: 'lost-write-same-intent',
      };
      const lost = await call('post_message', args);
      assert.equal(data(lost).error.code, 'network_error');
      assert.equal(lost.structuredContent.status, null);
      assert.match(data(lost).error.message, /same idempotency_key/);
      const retried = await call('post_message', args);
      assert.equal(retried.structuredContent.idempotency_replayed, true);
      assert.equal(data(retried).id, id('msg'));
      assert.deepEqual(received[0], received[1]);
      assert.equal(received.length, 2);
      assert.ok(!JSON.stringify(retried).includes(syntheticKey));
    },
    syntheticKey,
  );
});

test('an invalid identity leaves public reads usable and replacement remains an explicit choice', async () => {
  let registrations = 0;
  await fixture(
    (req, res) => {
      if (req.method === 'GET') {
        assert.equal(req.headers.authorization, undefined);
        res.end(JSON.stringify({ id: id('msg'), items: [], public_read: true }));
      } else if (req.url === '/api/v1/agents') {
        registrations++;
        res.writeHead(201).end(
          JSON.stringify({
            agent_id: id('agt', 'b'),
            api_key: 'ac_live_' + 'b'.repeat(43),
            key_id: 'key_replacement',
            profile_url: `/agents/${id('agt', 'b')}`,
          }),
        );
      } else {
        res.writeHead(401).end(
          JSON.stringify({
            error: {
              code: 'invalid_key',
              message: `Invalid, revoked, or suspended: ${syntheticKey}`,
            },
          }),
        );
      }
    },
    async (call) => {
      assert.equal(data(await call('get_identity')).credential_validity, 'unverified');
      const rejected = await call('post_message', {
        subject: 'Rejected',
        body: 'Fixture',
        idempotency_key: 'rejected-write-intent',
      });
      assert.equal(rejected.structuredContent.status, 401);
      assert.equal(data(rejected).identity.identity_ready, false);
      assert.equal(data(rejected).identity.credential_validity, 'invalid');
      assert.ok(!JSON.stringify(rejected).includes(syntheticKey));
      for (const [name, args] of [
        ['get_state', {}],
        ['search', { q: 'public' }],
        ['read_message', { id: id('msg') }],
      ])
        assert.equal(data(await call(name, args)).public_read, true);
      const reused = await call('create_identity', { idempotency_key: 'no-automatic-replacement' });
      assert.equal(reused.isError, true);
      assert.match(data(reused).next_step, /Do not use replacement to bypass a suspension/);
      assert.equal(registrations, 0);
      const replaced = await call('create_identity', {
        replace_existing: true,
        idempotency_key: 'explicit-replacement',
      });
      assert.equal(registrations, 1);
      assert.equal(data(replaced).credential_validity, 'valid');
      assert.equal(data(replaced).identity_ready, true);
      assert.ok(!JSON.stringify(replaced).includes('ac_live_'));
    },
    syntheticKey,
  );
});

test('a late rejection from an old request cannot invalidate an explicitly replaced identity', async () => {
  let rejectOldRequest;
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  await fixture(
    (req, res) => {
      if (req.url === '/api/v1/agents') {
        res
          .writeHead(201)
          .end(
            JSON.stringify({
              agent_id: id('agt', 'b'),
              api_key: 'ac_live_' + 'b'.repeat(43),
              key_id: 'key_new',
              profile_url: `/agents/${id('agt', 'b')}`,
            }),
          );
      } else {
        rejectOldRequest = () =>
          res
            .writeHead(401)
            .end(
              JSON.stringify({
                error: { code: 'invalid_key', message: 'The old key is revoked.' },
              }),
            );
        requestStarted();
      }
    },
    async (call) => {
      const pending = call('post_message', {
        subject: 'Old request',
        body: 'Fixture',
        idempotency_key: 'in-flight-old-key',
      });
      await started;
      const replacement = await call('create_identity', {
        replace_existing: true,
        idempotency_key: 'explicit-new-identity',
      });
      assert.equal(data(replacement).credential_validity, 'valid');
      rejectOldRequest();
      assert.equal((await pending).isError, true);
      assert.equal(data(await call('get_identity')).credential_validity, 'valid');
      assert.equal(data(await call('get_identity')).agent_id, id('agt', 'b'));
    },
    syntheticKey,
  );
});

test('artifact reads verify integrity, preserve BOM bytes and page Unicode content without executing it', async () => {
  // The BOM is part of the stored bytes and must survive decoding and integrity verification.
  const text = '\ufeff' + 'α🙂\n'.repeat(3000);
  let corrupt = false,
    oversized = false;
  await fixture(
    (req, res) => {
      if (req.url.endsWith('/content')) {
        res.setHeader('Content-Type', 'text/plain');
        res.end(oversized ? 'x'.repeat(262145) : corrupt ? `${text}wrong` : text);
      } else {
        res.end(
          JSON.stringify({
            id: id('art'),
            name: 'public.md',
            size: Buffer.byteLength(text),
            sha256: createHash('sha256').update(text).digest('hex'),
          }),
        );
      }
    },
    async (call) => {
      let offset = 0,
        combined = '';
      do {
        const response = await call('read_artifact', { id: id('art'), offset, limit: 4000 });
        assert.equal(response.isError, false);
        const chunk = data(response);
        assert.ok(Array.from(chunk.content).length <= 4000);
        assert.equal(chunk.content_trust, 'untrusted_public_contributions');
        assert.equal(
          JSON.parse(response.content[1].text).response.data,
          undefined,
          'metadata must not leak an unbounded full download',
        );
        combined += chunk.content;
        offset = chunk.next_offset;
      } while (offset !== null);
      assert.equal(combined, text);
      corrupt = true;
      const mismatch = await call('read_artifact', { id: id('art') });
      assert.equal(mismatch.isError, true);
      assert.equal(data(mismatch).error.code, 'artifact_integrity');
      assert.ok(!JSON.stringify(mismatch).includes('α🙂'));
      oversized = true;
      const large = await call('read_artifact', { id: id('art') });
      assert.equal(large.isError, true);
      assert.equal(data(large).error.code, 'response_too_large');
      assert.ok(JSON.stringify(large).length < 2000);
    },
  );
});
