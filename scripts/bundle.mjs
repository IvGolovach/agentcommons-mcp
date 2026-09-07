import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Usage: node scripts/bundle.mjs /absolute/output/agentcommons-mcp-0.3.0.mcpb
// Install package development dependencies with npm ci before running this builder.
// Only the allowlisted public package files below enter the isolated staging tree.
const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.argv[2];
if (!output || process.argv.length !== 3 || !isAbsolute(output) || !output.endsWith('.mcpb'))
  throw new Error('Provide one absolute .mcpb output path outside the package directory.');
const relativeOutput = relative(root, resolve(output));
if (relativeOutput !== '..' && !relativeOutput.startsWith(`..${sep}`))
  throw new Error('Bundle output must stay outside the package directory.');
for (const path of [output, `${output}.sha256`]) {
  if (
    await access(path).then(
      () => true,
      () => false,
    )
  )
    throw new Error(`Refusing to overwrite an existing artifact: ${path}`);
}
const run = promisify(execFile);
const workspace = await mkdtemp(join(tmpdir(), 'agentcommons-mcpb-build-'));
const stage = join(workspace, 'stage');
const tools = join(workspace, 'tools');
const archive = join(workspace, 'client.mcpb');
const extracted = join(workspace, 'extracted');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const cliVersion = '2.1.2';
let client;
try {
  await mkdir(stage);
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, packageJson.version, 'Manifest and package versions must match.');
  for (const file of ['package.json', 'package-lock.json', 'README.md', 'LICENSE', 'manifest.json'])
    await copyFile(join(root, file), join(stage, file));
  await run(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: stage,
    maxBuffer: 8 * 1024 * 1024,
  });
  await build({
    absWorkingDir: root,
    entryPoints: ['src/server.ts'],
    outfile: join(stage, 'dist/server.js'),
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: { js: '#!/usr/bin/env node' },
  });
  // Build/test scripts and dev dependencies are unnecessary in the installed bundle.
  const runtimePackage = Object.fromEntries(
    Object.entries(packageJson).filter(([name]) => !['scripts', 'devDependencies'].includes(name)),
  );
  await writeFile(join(stage, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`);
  await run(
    npm,
    [
      'install',
      '--prefix',
      tools,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--save-exact',
      `@anthropic-ai/mcpb@${cliVersion}`,
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  const cli = join(tools, 'node_modules/@anthropic-ai/mcpb/dist/cli/cli.js');
  const official = async (...args) =>
    run(process.execPath, [cli, ...args], { maxBuffer: 8 * 1024 * 1024 });
  await official('validate', join(stage, 'manifest.json'));
  await official('pack', stage, archive);

  // The official packer timestamps ZIP entries with the current time. Normalize
  // only those header timestamps, so rebuilding identical inputs keeps its hash.
  const bytes = await readFile(archive);
  const eocd = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(eocd), 0x06054b50, 'Expected a standard unsigned MCPB ZIP.');
  let central = bytes.readUInt32LE(eocd + 16);
  for (let entry = 0; entry < bytes.readUInt16LE(eocd + 10); entry++) {
    assert.equal(bytes.readUInt32LE(central), 0x02014b50);
    const local = bytes.readUInt32LE(central + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    // ZIP DOS date 1980-01-01 00:00:00; content and compression remain unchanged.
    bytes.writeUInt16LE(0, central + 12);
    bytes.writeUInt16LE(33, central + 14);
    bytes.writeUInt16LE(0, local + 10);
    bytes.writeUInt16LE(33, local + 12);
    central +=
      46 +
      bytes.readUInt16LE(central + 28) +
      bytes.readUInt16LE(central + 30) +
      bytes.readUInt16LE(central + 32);
  }
  await writeFile(archive, bytes);
  await official('unpack', archive, extracted);
  await official('validate', join(extracted, 'manifest.json'));

  // Execute the extracted payload with its bundled dependencies, isolated from
  // developer credentials. These MCP calls perform no network requests or writes.
  client = new Client({ name: 'agentcommons-bundle-verification', version: packageJson.version });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(extracted, manifest.server.entry_point)],
      env: {
        AGENTCOMMONS_URL: 'https://agentcommons.me',
        AGENTCOMMONS_STATE_DIR: join(workspace, 'identity'),
      },
    }),
  );
  const listed = (await client.listTools()).tools;
  for (const name of [
    'get_identity',
    'create_identity',
    'read_feed',
    'post_message',
    'read_task',
    'read_artifact',
  ])
    assert.ok(
      listed.some((tool) => tool.name === name),
      `Missing bundled tool: ${name}`,
    );
  const identity = await client.callTool({ name: 'get_identity', arguments: {} });
  assert.equal(identity.isError, false);
  assert.equal(identity.structuredContent.data.credential_validity, 'missing');
  await client.close();
  client = undefined;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await mkdir(dirname(output), { recursive: true });
  await copyFile(archive, output, constants.COPYFILE_EXCL);
  await writeFile(`${output}.sha256`, `${sha256}  ${output.split(sep).at(-1)}\n`, { flag: 'wx' });
  console.log(
    JSON.stringify(
      {
        output,
        sha256,
        bytes: bytes.length,
        tools: listed.length,
        cli: `@anthropic-ai/mcpb@${cliVersion}`,
        manifest_validation: 'PASS',
        extracted_stdio: 'PASS',
      },
      null,
      2,
    ),
  );
} finally {
  if (client) await client.close();
  await rm(workspace, { recursive: true, force: true });
}
