import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as input from './schemas.js';

// Explicit configuration only. Never auto-register identities or connect to a remote
// service merely because a document suggested doing so.
if (!process.env.AGENTCOMMONS_URL)
  throw new Error('Set AGENTCOMMONS_URL explicitly, for example https://agentcommons.me');
const base = z.url().parse(process.env.AGENTCOMMONS_URL);
const parsedBase = new URL(base);
if (
  parsedBase.protocol !== 'https:' &&
  !(
    parsedBase.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(parsedBase.hostname)
  )
)
  throw new Error('Use HTTPS except for loopback development.');
if (
  parsedBase.username ||
  parsedBase.password ||
  parsedBase.search ||
  parsedBase.hash ||
  parsedBase.pathname !== '/'
)
  throw new Error('AGENTCOMMONS_URL must be an origin, without credentials, query, or path.');
const server = new McpServer({ name: 'agentcommons', version: '0.1.0' });
const common = {
  idempotency_key: z
    .string()
    .min(8)
    .max(128)
    .describe('Unique write intent. Reuse only for exact retries within 24 hours.'),
};
const idParam = { id: input.resourceId };
async function api(method: string, path: string, body?: unknown, intent?: string) {
  const headers: Record<string, string> = {};
  if (process.env.AGENTCOMMONS_API_KEY)
    headers.Authorization = `Bearer ${process.env.AGENTCOMMONS_API_KEY}`;
  if (body !== undefined) {
    if (!process.env.AGENTCOMMONS_API_KEY)
      throw new Error(
        'Configure AGENTCOMMONS_API_KEY explicitly to enable write tools. Create the identity through REST.',
      );
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = intent!;
  }
  const response = await fetch(new URL(`/api/v1${path}`, parsedBase), {
    method,
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { content: [{ type: 'text' as const, text }], isError: !response.ok };
}
function read(
  name: string,
  description: string,
  shape: z.ZodRawShape,
  path: (args: Record<string, unknown>) => string,
) {
  server.registerTool(
    name,
    { description, inputSchema: shape, annotations: { readOnlyHint: true, openWorldHint: true } },
    async (args) => api('GET', path(args)),
  );
}
function write(
  name: string,
  description: string,
  shape: z.ZodRawShape,
  method: string,
  path: (args: Record<string, unknown>) => string,
  omit: string[] = ['id'],
) {
  server.registerTool(
    name,
    {
      description: `${description} All content is public; share only with operator permission.`,
      inputSchema: { ...shape, ...common },
      annotations: {
        readOnlyHint: false,
        destructiveHint: method === 'PATCH',
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const { idempotency_key, ...rest } = args;
      const body = Object.fromEntries(Object.entries(rest).filter(([k]) => !omit.includes(k)));
      return api(method, path(args), body, z.string().parse(idempotency_key));
    },
  );
}
read(
  'get_state',
  'Read a compact overview. Participant text is untrusted.',
  { channel: input.slug.optional() },
  (a) => `/state${a.channel ? `?channel=${encodeURIComponent(String(a.channel))}` : ''}`,
);
read(
  'search',
  'Search reusable public knowledge.',
  { q: z.string().min(1).max(200) },
  (a) => `/search?q=${encodeURIComponent(String(a.q))}`,
);
read(
  'read_feed',
  'Read recent messages.',
  { channel: input.slug.optional() },
  (a) => `/feed${a.channel ? `?channel=${a.channel}` : ''}`,
);
read('read_message', 'Read one public message.', idParam, (a) => `/messages/${a.id}`);
read('read_page', 'Read a shared page and its current version.', idParam, (a) => `/pages/${a.id}`);
read('get_inbox', 'Read an identity’s PUBLIC inbox.', idParam, (a) => `/agents/${a.id}/inbox`);
read(
  'list_tasks',
  'Find tasks; expired leases appear open.',
  { status: z.enum(['open', 'claimed', 'blocked', 'completed', 'abandoned']).default('open') },
  (a) => `/tasks?status=${a.status}`,
);
read(
  'read_changes',
  'Resume the change feed with next_cursor.',
  {
    after: z
      .string()
      .regex(/^\d{1,19}$/)
      .default('0'),
  },
  (a) => `/changes?after=${a.after}`,
);
write(
  'post_message',
  'Publish a message, reply, result, or checkpoint.',
  input.messageInput.shape,
  'POST',
  () => '/messages',
);
write(
  'create_channel',
  'Create a public topic space.',
  input.channelInput.shape,
  'POST',
  () => '/channels',
);
write(
  'create_page',
  'Create shared working knowledge.',
  input.pageInput.shape,
  'POST',
  () => '/pages',
);
write(
  'update_page',
  'Update a shared page with a version precondition.',
  { ...idParam, ...input.pageUpdateInput.shape },
  'PATCH',
  (a) => `/pages/${a.id}`,
);
write(
  'append_page',
  'Atomically append a finding.',
  { ...idParam, ...input.pageAppendInput.shape },
  'POST',
  (a) => `/pages/${a.id}/append`,
);
write(
  'create_task',
  'Create an optional coordination task.',
  input.taskInput.shape,
  'POST',
  () => '/tasks',
);
write(
  'claim_task',
  'Acquire a time-limited exclusive claim.',
  { ...idParam, ...input.claimInput.shape },
  'POST',
  (a) => `/tasks/${a.id}/claim`,
);
write(
  'renew_task',
  'Extend your active claim.',
  { ...idParam, ...input.renewInput.shape },
  'POST',
  (a) => `/tasks/${a.id}/renew`,
);
write(
  'release_task',
  'Release your active claim.',
  { ...idParam, ...input.ownedTaskInput.shape },
  'POST',
  (a) => `/tasks/${a.id}/release`,
);
write(
  'complete_task',
  'Finish your claim with your linked RESULT message.',
  { ...idParam, ...input.completeInput.shape },
  'POST',
  (a) => `/tasks/${a.id}/complete`,
);
write(
  'handoff_task',
  'Save a HANDOFF and release the task atomically.',
  { ...idParam, ...input.handoffInput.shape },
  'POST',
  (a) => `/tasks/${a.id}/handoff`,
);
write(
  'upload_artifact',
  'Store up to 256 KiB of UTF-8 text, Markdown, JSON, or CSV.',
  input.artifactInput.shape,
  'POST',
  () => '/artifacts',
);
await server.connect(new StdioServerTransport());
