import assert from 'node:assert/strict';
import { Codex } from '@openai/codex-sdk';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startResponseCapture, readResponseCapture } from '../response-capture.service.js';

const home = await mkdtemp(path.join(os.tmpdir(), 'codex-response-smoke-'));
let requests = 0;
const upstream = createServer(async (req, res) => {
  for await (const _chunk of req) { /* consume the native request without logging it */ }
  assert.equal(req.headers.authorization, process.argv.includes('--chatgpt') ? 'Bearer smoke-token' : 'Bearer smoke');
  requests++;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const message = { id: 'msg_smoke', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'monitor smoke passed', annotations: [] }] };
  const response = { id: 'resp_smoke', object: 'response', created_at: 1, status: 'completed', model: 'actual-native-model', output: [message], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } };
  for (const event of [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: 'monitor smoke passed' },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response },
  ]) res.write('data: ' + JSON.stringify(event) + '\n\n');
  res.end();
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const capture = await startResponseCapture(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`, 'native-smoke-' + process.pid);
try {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => entry[1] !== undefined));
  const chatgpt = process.argv.includes('--chatgpt');
  for (const key of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']) delete env[key];
  if (chatgpt) await writeFile(path.join(home, 'auth.json'), JSON.stringify({ last_refresh: '2099-01-01T00:00:00Z', tokens: { id_token: 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJlbWFpbCI6InVzZXJAZXhhbXBsZS5jb20iLCJlbWFpbF92ZXJpZmllZCI6dHJ1ZSwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS9hdXRoIjp7ImNoYXRncHRfdXNlcl9pZCI6InVzZXItMTIzNDUiLCJ1c2VyX2lkIjoidXNlci0xMjM0NSIsImNoYXRncHRfcGxhbl90eXBlIjoicHJvIiwiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjb3VudC0xMjMifX0.c2ln', access_token: 'smoke-token', refresh_token: 'smoke-refresh', account_id: 'smoke' } }));
  const codex = new Codex({ env: { ...env, CODEX_HOME: home, ...(chatgpt ? {} : { CODEX_API_KEY: 'smoke' }) }, ...(chatgpt ? {} : { apiKey: 'smoke' }), config: { model_provider: 'cloudcli_monitor', model_providers: { cloudcli_monitor: { name: chatgpt ? 'mintcli Codex' : 'Monitor', base_url: capture.baseUrl, ...(chatgpt ? {} : { env_key: 'CODEX_API_KEY' }), wire_api: 'responses', requires_openai_auth: chatgpt, supports_websockets: false } } } });
  const result = await codex.startThread({ workingDirectory: home, skipGitRepoCheck: true, model: 'requested-alias', sandboxMode: 'danger-full-access', approvalPolicy: 'never' }).run('Say hello', { signal: AbortSignal.timeout(30000) });
  const records = await readResponseCapture('native-smoke-' + process.pid);
  if (result.finalResponse !== 'monitor smoke passed' || records.at(-1)?.model !== 'actual-native-model') throw new Error('native response verification failed');
  console.log(JSON.stringify({ status: 'passed', mode: chatgpt ? 'chatgpt' : 'api', requests, returnedModel: records.at(-1)?.model, finalResponse: result.finalResponse }));
} finally {
  await capture.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
  await rm(path.join(os.homedir(), '.claude-code-ui/token-monitor', 'native-smoke-' + process.pid + '.jsonl'), { force: true });
}
