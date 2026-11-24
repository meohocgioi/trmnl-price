// Tạo (nếu chưa có) KV namespace "trmnl-price-kv" và điền id vào wrangler.toml
import { readFileSync, writeFileSync } from 'node:fs';

const TITLE = 'trmnl-price-kv';
const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account } = process.env;
if (!token || !account) {
  console.error('Thiếu secrets CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID trong GitHub repo');
  process.exit(1);
}
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces`;
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

async function call(url, init) {
  const r = await fetch(url, { headers, ...init });
  const j = await r.json();
  if (!j.success) throw new Error(JSON.stringify(j.errors));
  return j.result;
}

let id;
for (let page = 1; !id; page++) {
  const list = await call(`${base}?per_page=100&page=${page}`);
  id = list.find((n) => n.title === TITLE)?.id;
  if (list.length < 100) break;
}
if (!id) {
  id = (await call(base, { method: 'POST', body: JSON.stringify({ title: TITLE }) })).id;
  console.log('Đã tạo KV', TITLE, id);
} else {
  console.log('Dùng KV có sẵn', TITLE, id);
}
const f = 'wrangler.toml';
writeFileSync(f, readFileSync(f, 'utf8').replace('__KV_ID__', id));
