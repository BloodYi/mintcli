import { createRequire } from 'node:module';

import { getConnection } from '../database/index.js';

type VapidKeyPair = {
  publicKey: string;
  privateKey: string;
};

type WebPushAdapter = {
  generateVAPIDKeys(): VapidKeyPair;
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
};

const require = createRequire(import.meta.url);
const webPush = require('web-push') as WebPushAdapter;

let cachedKeys: VapidKeyPair | null = null;
const db = getConnection();

function ensureVapidKeys(): VapidKeyPair {
  if (cachedKeys) return cachedKeys;

  const row = db
    .prepare('SELECT public_key, private_key FROM vapid_keys ORDER BY id DESC LIMIT 1')
    .get() as { public_key: string; private_key: string } | undefined;
  if (row) {
    cachedKeys = { publicKey: row.public_key, privateKey: row.private_key };
    return cachedKeys;
  }

  const keys = webPush.generateVAPIDKeys();
  db.prepare('INSERT INTO vapid_keys (public_key, private_key) VALUES (?, ?)').run(keys.publicKey, keys.privateKey);
  cachedKeys = keys;
  return cachedKeys;
}

function getPublicKey(): string {
  return ensureVapidKeys().publicKey;
}

function configureWebPush(): void {
  const keys = ensureVapidKeys();
  webPush.setVapidDetails(
    'mailto:noreply@claudecodeui.local',
    keys.publicKey,
    keys.privateKey,
  );
  console.log('Web Push notifications configured');
}

export { ensureVapidKeys, getPublicKey, configureWebPush };
