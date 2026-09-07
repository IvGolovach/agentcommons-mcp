import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../dist/server.js', import.meta.url));
async function connect(env) {
  const client = new Client({ name: 'client-contract-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env }));
  return client;
}
const data = (result) => JSON.parse(result.content[0].text);

test('fresh default client needs no origin or key and explains the next callable step', async () => {
  const state = await mkdtemp(join(tmpdir(), 'agentcommons-client-'));
  let client;
  try {
    client = await connect({ AGENTCOMMONS_STATE_DIR: state });
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 25);
    assert.equal(
      tools.tools.find((t) => t.name === 'create_identity').annotations.readOnlyHint,
      false,
    );
    assert.equal(
      data(await client.callTool({ name: 'get_identity', arguments: {} })).identity_ready,
      false,
    );
    const result = await client.callTool({
      name: 'post_message',
      arguments: {
        subject: 'No identity yet',
        body: 'This must not be transmitted.',
        idempotency_key: 'no-key-contract-test',
      },
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /Call create_identity first/);
  } finally {
    await client?.close();
    await rm(state, { recursive: true, force: true });
  }
});

test('MCP creates, activates, privately persists and restores an identity without host configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentcommons-onboarding-'));
  const state = join(root, 'state');
  const key = 'ac_live_' + 'k'.repeat(43);
  let registrations = 0;
  let writes = 0;
  const http = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v1/agents') {
      registrations++;
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers['idempotency-key'], 'fresh-registration-intent');
      assert.equal(JSON.parse(raw).name, 'MCP newcomer');
      res.writeHead(201).end(
        JSON.stringify({
          agent_id: 'agt_' + 'a'.repeat(24),
          api_key: key,
          key_id: 'key_1',
          profile_url: '/agents/agt_' + 'a'.repeat(24),
        }),
      );
    } else if (req.url === '/api/v1/messages') {
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      assert.equal(req.headers['idempotency-key'], 'fresh-message-intent');
      writes++;
      res.writeHead(201).end(JSON.stringify({ id: 'msg_' + 'b'.repeat(24), ...JSON.parse(raw) }));
    } else {
      res.writeHead(404).end('{}');
    }
  });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const env = { AGENTCOMMONS_URL: origin, AGENTCOMMONS_STATE_DIR: state };
  let client;
  try {
    client = await connect(env);
    const create = () =>
      client.callTool({
        name: 'create_identity',
        arguments: { name: 'MCP newcomer', idempotency_key: 'fresh-registration-intent' },
      });
    const [first, retry] = await Promise.all([create(), create()]);
    assert.equal(first.isError, false);
    assert.equal(data(first).identity_ready, true);
    assert.equal(data(retry).agent_id, data(first).agent_id);
    assert.equal(registrations, 1);
    assert.ok(!JSON.stringify(first).includes(key));
    const [file] = await readdir(state);
    assert.equal((await stat(join(state, file))).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(join(state, file), 'utf8')).origin, origin);
    const post = () =>
      client.callTool({
        name: 'post_message',
        arguments: {
          subject: 'Readback test',
          body: 'An actual local client test.',
          idempotency_key: 'fresh-message-intent',
        },
      });
    assert.equal((await post()).isError, false);
    await client.close();
    client = await connect(env);
    const restored = data(await client.callTool({ name: 'get_identity', arguments: {} }));
    assert.equal(restored.agent_id, data(first).agent_id);
    assert.equal(restored.credential_source, 'private_file');
    assert.equal(restored.credential_validity, 'unverified');
    assert.equal(restored.identity_ready, false);
    assert.equal((await post()).isError, false);
    assert.equal(
      data(await client.callTool({ name: 'get_identity', arguments: {} })).credential_validity,
      'valid',
    );
    assert.equal(registrations, 1);
    assert.equal(writes, 2);
    await client.close();
    const saved = JSON.parse(await readFile(join(state, file), 'utf8'));
    await writeFile(
      join(state, file),
      JSON.stringify({ ...saved, origin: 'https://other.invalid' }),
    );
    client = await connect(env);
    assert.equal(
      data(await client.callTool({ name: 'get_identity', arguments: {} })).identity_ready,
      false,
    );
    assert.equal(
      registrations,
      1,
      'A saved key from another origin must never be adopted or trigger registration',
    );
    await client.close();
    // An unavailable state directory must not block registration or publication.
    const blocked = join(root, 'not-a-directory');
    await writeFile(blocked, 'fixture');
    client = await connect({ ...env, AGENTCOMMONS_STATE_DIR: blocked });
    const transient = data(await create());
    assert.equal(transient.credential_source, 'session_memory');
    assert.equal((await post()).isError, false);
    assert.ok(!JSON.stringify(transient).includes(key));
  } finally {
    await client?.close();
    await new Promise((r) => http.close(r));
    await rm(root, { recursive: true, force: true });
  }
});
