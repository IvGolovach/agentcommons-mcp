#!/usr/bin/env node
// A controlled two-client protocol example. Fixture records are public on the chosen service.
// No client is given the other client's resource IDs: the second knows only origin and topic.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const fixture = {
  csv: 'item,amount\nalpha,12.50\nbeta,7.25\ngamma,3.00\n',
  expected_total: 22.75,
};
const steps = [
  ['question_published', 'First client publishes a question'],
  ['working_page_created', 'First client creates shared working notes'],
  ['evidence_uploaded', 'First client uploads a public CSV fixture'],
  ['task_handed_off', 'First client saves a handoff and releases its lease'],
  ['context_discovered', 'Second client discovers the task and conversation through pagination'],
  ['evidence_read', 'Second client reads the handoff, shared page and verified artifact'],
  ['answer_published', 'Second client answers the question with the computed total'],
  ['shared_page_updated', 'Second client appends its finding to the shared page'],
  ['task_completed', 'Second client completes its claim with a linked result'],
  ['result_read_back', 'First client finds the answer and reads the result back'],
  ['question_resolved', 'First client resolves its original question'],
];
async function call(client, name, args = {}, write = false) {
  const result = await client.callTool({
    name,
    arguments: { ...args, ...(write ? { idempotency_key: randomUUID() } : {}) },
  });
  // Never include complete error responses, arguments or credentials in an exception.
  assert.ok(!result.isError, `${name} failed; inspect the service using its request ID.`);
  return JSON.parse(result.content[0].text);
}
async function collect(client, name, args = {}) {
  const items = [],
    cursors = new Set();
  let cursor,
    pages = 0;
  do {
    assert.ok(pages < 100, `${name} exceeded the bounded 100-page example scan.`);
    const result = await call(client, name, { ...args, limit: 20, ...(cursor ? { cursor } : {}) });
    pages++;
    items.push(...result.items);
    cursor = result.next_cursor;
    if (cursor) {
      assert.ok(!cursors.has(cursor), `${name} repeated a cursor.`);
      cursors.add(cursor);
    }
  } while (cursor);
  assert.equal(
    new Set(items.map((item) => item.id)).size,
    items.length,
    `${name} repeated a record.`,
  );
  return { items, pages };
}
async function prepare(first, topic) {
  const identity = await call(
    first,
    'create_identity',
    { name: `${topic} controlled first client` },
    true,
  );
  assert.equal(identity.identity_ready, true);
  assert.equal(identity.api_key, undefined);
  const artifact = await call(
    first,
    'upload_artifact',
    {
      name: 'controlled-total.csv',
      description: 'Controlled arithmetic fixture, not user financial data.',
      content: fixture.csv,
    },
    true,
  );
  const page = await call(
    first,
    'create_page',
    {
      slug: topic,
      title: `${topic}: working notes`,
      body: 'Controlled example. Read the public CSV, calculate the amount total, and record verification limits.',
    },
    true,
  );
  const question = await call(
    first,
    'post_message',
    {
      type: 'QUESTION',
      subject: `${topic}: calculate the fixture total`,
      body: 'Please total the amount column of the attached public CSV and append the result to the shared page. This is a controlled protocol example.',
      page_id: page.id,
      artifacts: [artifact.id],
    },
    true,
  );
  const task = await call(
    first,
    'create_task',
    {
      title: `${topic}: verify fixture total`,
      description:
        'Find the linked HANDOFF, read its evidence and question, calculate the amount total, and complete with a linked RESULT.',
    },
    true,
  );
  const claim = await call(first, 'claim_task', { id: task.id }, true);
  const handoff = await call(
    first,
    'handoff_task',
    {
      id: task.id,
      claim_id: claim.claim_id,
      subject: `${topic}: continuation context`,
      body: 'Read the public references in metadata before calculating. First client has not computed the total.',
      metadata: { question_id: question.id, page_id: page.id, artifact_id: artifact.id },
    },
    true,
  );
  assert.equal(handoff.task.status, 'open');
  // Put target records behind the default page, including the task conversation.
  for (let index = 0; index < 21; index++) {
    await call(
      first,
      'create_task',
      {
        title: `${topic}: pagination fixture ${index}`,
        description: 'Controlled pagination record. No work requested.',
      },
      true,
    );
    await call(
      first,
      'post_message',
      {
        subject: `${topic}: checkpoint fixture ${index}`,
        body: 'Controlled pagination fixture. Read the HANDOFF for the actionable context.',
        task_id: task.id,
        to: identity.agent_id,
      },
      true,
    );
  }
  return { identity, question, task, page, artifact };
}
// The only external task input is the topic. All IDs below come from this client's reads.
async function continueWork(second, topic) {
  await call(second, 'get_state');
  const identity = await call(
    second,
    'create_identity',
    { name: `${topic} controlled second client` },
    true,
  );
  const search = await collect(second, 'search', { q: topic });
  const candidate = search.items.find(
    (item) => item.kind === 'task' && item.title === `${topic}: verify fixture total`,
  );
  assert.ok(candidate, 'The second client could not discover its task by topic.');
  const tasks = await collect(second, 'list_tasks', { status: 'open', channel: 'general' });
  assert.ok(tasks.items.some((task) => task.id === candidate.id));
  const task = await call(second, 'read_task', { id: candidate.id });
  const conversation = await collect(second, 'read_feed', { task_id: task.id });
  const checkpoint = conversation.items.find((message) => message.type === 'HANDOFF');
  assert.ok(checkpoint, 'The second client could not find the handoff.');
  const handoff = await call(second, 'read_message', { id: checkpoint.id });
  const question = await call(second, 'read_message', { id: handoff.metadata.question_id });
  const page = await call(second, 'read_page', { id: handoff.metadata.page_id });
  assert.equal(question.page_id, page.id);
  assert.ok(question.artifacts.includes(handoff.metadata.artifact_id));
  let offset = 0,
    csv = '',
    artifactChunks = 0;
  do {
    const part = await call(second, 'read_artifact', {
      id: handoff.metadata.artifact_id,
      offset,
      limit: 24,
    });
    assert.equal(part.content_trust, 'untrusted_public_contributions');
    csv += part.content;
    offset = part.next_offset;
    artifactChunks++;
  } while (offset !== null);
  const cents = csv
    .trim()
    .split('\n')
    .slice(1)
    .reduce((sum, line) => {
      const amount = line.split(',')[1];
      assert.match(amount, /^\d+\.\d{2}$/);
      return sum + Number(amount.replace('.', ''));
    }, 0);
  const total = cents / 100;
  const claim = await call(second, 'claim_task', { id: task.id }, true);
  await call(
    second,
    'post_message',
    {
      type: 'ANSWER',
      channel: question.channel,
      to: question.agent_id,
      reply_to: question.id,
      page_id: page.id,
      task_id: task.id,
      references: [question.id],
      continues_from: handoff.id,
      subject: `${topic}: verified fixture total`,
      body: `The public fixture totals ${total.toFixed(2)}. Computed from the CSV amount column in integer cents. Controlled local protocol demonstration; not independent operators or production validation.`,
    },
    true,
  );
  await call(
    second,
    'append_page',
    {
      id: page.id,
      summary: 'Record the verified controlled-fixture total.',
      body: `Verified fixture total: ${total.toFixed(2)}. The second client read the artifact and computed in integer cents. This verifies the example data and communication path only.`,
    },
    true,
  );
  const result = await call(
    second,
    'post_message',
    {
      type: 'RESULT',
      channel: task.channel,
      task_id: task.id,
      page_id: page.id,
      to: question.agent_id,
      continues_from: handoff.id,
      references: [question.id],
      subject: `${topic}: completed fixture verification`,
      body: `Computed total ${total.toFixed(2)} and appended the finding to the shared page. Completion is author-reported; this is a controlled example.`,
      artifacts: [handoff.metadata.artifact_id],
    },
    true,
  );
  await call(
    second,
    'complete_task',
    { id: task.id, claim_id: claim.claim_id, result_message_id: result.id },
    true,
  );
  return {
    agent_id: identity.agent_id,
    total,
    artifactChunks,
    pagination: {
      search_pages: search.pages,
      task_pages: tasks.pages,
      message_pages: conversation.pages,
    },
  };
}
async function verifyFromFirst(first, prepared, topic) {
  // Push the answer behind 20 newer inbox messages before the first client resumes.
  for (let index = 0; index < 21; index++)
    await call(
      first,
      'post_message',
      {
        to: prepared.identity.agent_id,
        subject: `${topic}: inbox pagination fixture ${index}`,
        body: 'Controlled newer inbox record. No action requested.',
      },
      true,
    );
  const inbox = await collect(first, 'get_inbox', { id: prepared.identity.agent_id });
  const answer = inbox.items.find(
    (message) => message.type === 'ANSWER' && message.reply_to === prepared.question.id,
  );
  assert.ok(answer, 'The first client could not discover its answer in its own inbox.');
  const replies = await collect(first, 'read_feed', { reply_to: prepared.question.id });
  assert.ok(replies.items.some((message) => message.id === answer.id));
  const task = await call(first, 'read_task', { id: prepared.task.id });
  assert.equal(task.status, 'completed');
  const result = await call(first, 'read_message', { id: task.result_message_id });
  const page = await call(first, 'read_page', { id: prepared.page.id });
  assert.equal(result.task_id, task.id);
  assert.equal(result.type, 'RESULT');
  assert.equal(result.agent_id, answer.agent_id);
  assert.ok(result.body.includes(fixture.expected_total.toFixed(2)));
  assert.ok(page.body.includes(fixture.expected_total.toFixed(2)));
  assert.equal(page.version, 2);
  await call(first, 'resolve_message', { id: prepared.question.id }, true);
  assert.ok((await call(first, 'read_message', { id: prepared.question.id })).resolved_at);
  return { inbox_pages: inbox.pages, page_version: page.version };
}
export async function runJourney({
  origin,
  entry = fileURLToPath(new URL('../dist/server.js', import.meta.url)),
  allowPublic = false,
}) {
  const url = new URL(origin);
  assert.ok(
    url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash,
    'Use a plain service origin.',
  );
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  assert.ok(
    loopback || allowPublic,
    'This example creates public records. Non-loopback origins require the explicit --allow-public option.',
  );
  assert.ok(
    url.protocol === 'https:' || (loopback && url.protocol === 'http:'),
    'HTTPS is required except for loopback.',
  );
  const state = await mkdtemp(join(tmpdir(), 'agentcommons-journey-'));
  const clients = [];
  const launch = async (profile) => {
    const client = new Client({ name: `controlled-${profile}`, version: '1.0.0' });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve(entry)],
        env: {
          PATH: process.env.PATH,
          AGENTCOMMONS_URL: url.origin,
          AGENTCOMMONS_STATE_DIR: join(state, profile),
        },
        stderr: 'pipe',
      }),
    );
    return client;
  };
  try {
    const first = await launch('first');
    const tools = (await first.listTools()).tools;
    for (const name of ['read_task', 'read_artifact', 'resolve_message'])
      assert.ok(tools.some((tool) => tool.name === name));
    const topic = `mcpjourney${randomBytes(6).toString('hex')}`;
    const prepared = await prepare(first, topic);
    const second = await launch('second');
    const continued = await continueWork(second, topic);
    assert.notEqual(continued.agent_id, prepared.identity.agent_id);
    assert.equal(continued.total, fixture.expected_total);
    const verified = await verifyFromFirst(first, prepared, topic);
    const pagination = { ...continued.pagination, inbox_pages: verified.inbox_pages };
    for (const count of Object.values(pagination))
      assert.ok(count > 1, 'The example must exercise more than one page.');
    await first.close();
    const resumed = await launch('first');
    assert.equal((await call(resumed, 'get_identity')).agent_id, prepared.identity.agent_id);
    await call(
      resumed,
      'post_message',
      {
        subject: `${topic}: identity restored`,
        body: 'The first client reused its private saved identity after restart.',
        reply_to: prepared.question.id,
      },
      true,
    );
    const record = {
      kind: 'agentcommons-controlled-collaboration',
      schema_version: 1,
      verified_at: new Date().toISOString(),
      environment: loopback ? 'loopback' : 'explicit-public-test',
      command: 'node scripts/journey.mjs --origin <service-origin>',
      claims: { independent_operators: false, production: false },
      participants: 2,
      steps: steps.map(([id, label]) => ({ id, label, passed: true })),
      result: {
        expected_total: fixture.expected_total,
        observed_total: continued.total,
        page_version: verified.page_version,
        artifact_chunks: continued.artifactChunks,
        identity_restored: true,
      },
      pagination,
      limits: [
        'Controlled client sessions, not independent operators or organic community activity.',
        'Fixture data only; the example does not verify arbitrary participant claims.',
        'Local fixture IDs are not evidence of a production deployment.',
      ],
    };
    assert.ok(!JSON.stringify(record).includes('ac_live_'));
    return record;
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await rm(state, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const value = (name) => args[args.indexOf(name) + 1];
  try {
    assert.ok(
      args.includes('--origin') && value('--origin'),
      'Usage: node scripts/journey.mjs --origin http://127.0.0.1:3000 [--entry dist/server.js] [--allow-public]',
    );
    const record = await runJourney({
      origin: value('--origin'),
      ...(args.includes('--entry') ? { entry: value('--entry') } : {}),
      allowPublic: args.includes('--allow-public'),
    });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `Controlled journey failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exitCode = 1;
  }
}
