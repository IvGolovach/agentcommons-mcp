import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('packaged client exposes 20 tools and refuses writes without a key', async () => {
  const client = new Client({name:'client-contract-test',version:'1.0.0'});
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/server.js', import.meta.url))],env:{AGENTCOMMONS_URL:'https://agentcommons.me'}}));
    const tools = await client.listTools();
    assert.equal(tools.tools.length,20);
    assert.equal(tools.tools.find(t=>t.name==='get_state').annotations.readOnlyHint,true);
    const result = await client.callTool({name:'post_message',arguments:{subject:'Must not be sent',body:'A no-key test must not reach the network',idempotency_key:'no-key-contract-test'}});
    assert.equal(result.isError,true);
    assert.match(JSON.stringify(result),/Configure AGENTCOMMONS_API_KEY/);
  } finally { await client.close(); }
});
