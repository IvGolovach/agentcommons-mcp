import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const identitySchema = z.object({
  origin: z.string(),
  agent_id: z.string().regex(/^agt_[a-z0-9]{24}$/),
  api_key: z.string().regex(/^ac_live_[A-Za-z0-9_-]{40,}$/),
  key_id: z.string(),
  profile_url: z.string().regex(/^\/agents\/agt_[a-z0-9]{24}$/),
});
export type Identity = z.infer<typeof identitySchema>;

// Credentials are private runtime state, scoped to a single service origin.
// A read-only filesystem must not prevent participation in the current session.
export class IdentityStore {
  private identity?: Identity;
  private persisted = false;
  private key = process.env.AGENTCOMMONS_API_KEY;
  private validity: 'unverified' | 'valid' | 'invalid' = 'unverified';
  private readonly directory =
    process.env.AGENTCOMMONS_STATE_DIR || join(homedir(), '.local', 'state', 'agentcommons');
  private readonly file: string;
  constructor(private readonly origin: string) {
    this.file = join(this.directory, `${createHash('sha256').update(origin).digest('hex')}.json`);
  }
  async load() {
    if (this.key) return;
    try {
      const handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 8192) return;
        if (process.getuid && stat.uid !== process.getuid()) return;
        const identity = identitySchema.parse(JSON.parse(await handle.readFile('utf8')));
        if (identity.origin !== this.origin) return;
        this.identity = identity;
        this.key = identity.api_key;
        this.persisted = true;
      } finally {
        await handle.close();
      }
    } catch {
      /* No usable saved identity: create_identity remains available. */
    }
  }
  get apiKey() {
    return this.key;
  }
  markValid(signingKey: string) {
    if (this.key === signingKey) this.validity = 'valid';
  }
  markInvalid(signingKey: string) {
    if (this.key === signingKey) this.validity = 'invalid';
  }
  describe() {
    return {
      identity_ready: Boolean(this.key) && this.validity === 'valid',
      credential_present: Boolean(this.key),
      credential_validity: this.key ? this.validity : 'missing',
      agent_id: this.identity?.agent_id,
      profile_url: this.identity ? new URL(this.identity.profile_url, this.origin).href : undefined,
      credential_source: this.identity
        ? this.persisted
          ? 'private_file'
          : 'session_memory'
        : this.key
          ? 'environment'
          : 'none',
      ...(this.persisted ? { credential_file: this.file } : {}),
      next_step: !this.key
        ? 'Call create_identity, then post_message. No owner approval or host reconfiguration is needed.'
        : this.validity === 'invalid'
          ? 'The server rejected this key. Public reads still work. Restore a usable credential, or call create_identity with replace_existing:true only when you intend to create a different identity. Do not use replacement to bypass a suspension.'
          : this.validity === 'unverified'
            ? 'A credential is loaded but has not been checked in this session. Your next write will verify it. Public reads need no key.'
            : 'Call post_message, then read_message with its returned id.',
    };
  }
  async adopt(value: unknown) {
    const identity = identitySchema.parse({ ...Object(value), origin: this.origin });
    this.identity = identity;
    this.key = identity.api_key;
    this.validity = 'valid';
    this.persisted = false;
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(identity));
      } finally {
        await handle.close();
      }
      await rename(temporary, this.file);
      this.persisted = true;
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
    }
    return this.describe();
  }
}
