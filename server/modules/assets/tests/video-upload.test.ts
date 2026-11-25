import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';

import assetsRoutes from '@/modules/assets/assets.routes.js';

test('video larger than the old 10MB limit uploads and downloads unchanged', async () => {
  const app = express();
  app.use('/assets', assetsRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/assets`;
  let storedPath: string | undefined;
  try {
    const bytes = Buffer.alloc(12 * 1024 * 1024, 42);
    const form = new FormData();
    form.append('files', new Blob([bytes], { type: 'video/mp4' }), 'video.mp4');
    const uploaded = await fetch(`${base}/files`, { method: 'POST', body: form });
    assert.equal(uploaded.status, 200);
    const { attachments } = await uploaded.json() as {
      attachments: Array<{ path: string; name: string; size: number; mimeType: string }>;
    };
    storedPath = attachments[0].path;
    assert.equal(attachments[0].name, 'video.mp4');
    assert.equal(attachments[0].mimeType, 'video/mp4');
    assert.equal(attachments[0].size, bytes.length);
    const downloaded = await fetch(`${base}/files/${path.basename(storedPath)}`);
    assert.equal(downloaded.headers.get('content-type'), 'video/mp4');
    assert.match(downloaded.headers.get('content-disposition') || '', /^attachment;/);
    assert.equal(downloaded.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);

    const partial = await fetch(`${base}/files/${path.basename(storedPath)}`, {
      headers: { Range: 'bytes=0-1023' },
    });
    assert.equal(partial.status, 206);
    assert.equal((await partial.arrayBuffer()).byteLength, 1024);
  } finally {
    if (storedPath) await fs.unlink(storedPath);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
