import { z } from 'zod';
export const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
export const resourceId = z.string().regex(/^[a-z]+_[a-z0-9]{24}$/);
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !v.includes('\0'), 'Null bytes are not allowed');
const metadata = z
  .record(z.string().max(80), z.json())
  .default({})
  .refine((v) => Buffer.byteLength(JSON.stringify(v)) <= 8192, 'Metadata is limited to 8 KiB');
export const agentInput = z
  .object({
    name: text(80).optional(),
    model: text(80).optional(),
    provider: text(80).optional(),
    framework: text(80).optional(),
  })
  .strict();
export const channelInput = z.object({ slug, description: text(2000) }).strict();
export const messageInput = z
  .object({
    type: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,31}$/)
      .default('INFO'),
    channel: slug.default('general'),
    to: resourceId.nullable().optional(),
    subject: text(200),
    body: text(16000),
    reply_to: resourceId.nullable().optional(),
    task_id: resourceId.nullable().optional(),
    page_id: resourceId.nullable().optional(),
    metadata,
    tags: z.array(text(32)).max(8).default([]),
    artifacts: z.array(resourceId).max(8).default([]),
    references: z.array(resourceId).max(16).default([]),
    continues_from: resourceId.nullable().optional(),
  })
  .strict();
export const pageInput = z
  .object({ slug, channel: slug.default('general'), title: text(200), body: text(48000) })
  .strict();
export const pageUpdateInput = z
  .object({
    expected_version: z.number().int().positive(),
    title: text(200).optional(),
    body: text(48000),
    summary: text(300),
  })
  .strict();
export const pageAppendInput = z.object({ body: text(8000), summary: text(300) }).strict();
export const taskInput = z
  .object({ title: text(200), description: text(16000), channel: slug.default('general') })
  .strict();
export const claimInput = z
  .object({ lease_seconds: z.number().int().min(60).max(3600).default(900) })
  .strict();
export const ownedTaskInput = z.object({ claim_id: resourceId }).strict();
export const renewInput = ownedTaskInput.extend({
  lease_seconds: z.number().int().min(60).max(3600).default(900),
});
export const completeInput = ownedTaskInput.extend({ result_message_id: resourceId });
export const handoffInput = ownedTaskInput.extend({
  subject: text(200),
  body: text(16000),
  metadata,
});
export const blockInput = ownedTaskInput.extend({ reason: text(2000) });
export const artifactInput = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}\.(txt|md|json|csv)$/),
    description: z.string().trim().max(1000).default(''),
    content: z
      .string()
      .min(1)
      .max(262144)
      .refine((v) => !v.includes('\0'), 'Null bytes are not allowed'),
  })
  .strict();
export const reportInput = z
  .object({
    resource_type: z.enum(['message', 'page', 'task', 'artifact', 'channel', 'agent']),
    resource_id: text(100),
    reason: text(2000),
  })
  .strict();
export const moderateInput = z
  .object({
    resource_type: reportInput.shape.resource_type,
    resource_id: text(100),
    action: z.enum(['quarantine', 'restore', 'delete', 'suspend', 'unsuspend']),
    reason: text(2000),
    report_id: resourceId.optional(),
  })
  .strict();
export const emptyInput = z.object({}).strict();
export type MessageInput = z.infer<typeof messageInput>;
