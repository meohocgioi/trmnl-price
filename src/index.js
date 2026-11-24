import { refresh, readAll } from './store.js';
import { buildView } from './view.js';
import { getSettings } from './settings.js';
import { handleTelegram, setupWebhook } from './telegram.js';
import { autoUpdate } from './updater.js';

const json = (o, status = 200) =>
  new Response(JSON.stringify(o, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

// Telegram có thể tạm khoá bot mới tạo (lỗi 429). Cron tự thử nối webhook tới khi được.
async function autoConnect(env) {
  if (!env.TELEGRAM_BOT_TOKEN || (await env.KV.get('tg:ready')) === env.TELEGRAM_BOT_TOKEN.split(':')[0]) return;
  const origin = (await env.KV.get('origin')) || 'https://trmnl-price.meohocgioi.workers.dev';
  const r = await setupWebhook(env, origin, { welcome: true });
  if (r.ok) await env.KV.put('tg:ready', env.TELEGRAM_BOT_TOKEN.split(':')[0]);
}

export async function screen(env) {
  return buildView(await readAll(env), await getSettings(env));
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === '/' || p === '/health') return json({ ok: true, name: 'trmnl-price', version: env.VERSION || null });

    // Dữ liệu cho TRMNL (Polling). Cron làm mới 5 phút/lần; ở đây chỉ bù khi cron trễ (bỏ nguồn nặng).
    if (p === '/trmnl') {
      const last = Number(await env.KV.get('lastRefresh')) || 0;
      if (Date.now() - last > 12 * 60000) await refresh(env, { light: true });
      return json(await screen(env));
    }

    // Kiểm tra nhanh (chỉ bật khi có biến DEBUG_KEY — bản deploy bình thường không có)
    if (p === '/debug' && env.DEBUG_KEY && url.searchParams.get('k') === env.DEBUG_KEY) {
      const only = url.searchParams.get('only');
      const r = await refresh(env, { force: true, only: only ? only.split(',') : undefined });
      const trace = await fetch('https://www.cloudflare.com/cdn-cgi/trace').then((x) => x.text()).catch((e) => String(e));
      const where = trace.split('\n').filter((l) => /^(ip|colo|loc)=/.test(l)).join(' ');
      return json({ where, result: r.result, view: buildView(r.data, r.settings) });
    }

    if (p === '/tg' && req.method === 'POST') return handleTelegram(req, env, ctx);
    if (p === '/setup') {
      await env.KV.put('origin', url.origin);
      const r = await setupWebhook(env, url.origin, { welcome: true });
      if (r.ok && env.TELEGRAM_BOT_TOKEN) await env.KV.put('tg:ready', env.TELEGRAM_BOT_TOKEN.split(':')[0]);
      return json(r);
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const r = await refresh(env);
      await env.KV.put('lastRefresh', String(Date.now()));
      if (Object.keys(r.result).length) console.log('refresh', JSON.stringify(r.result));
    })().catch((e) => console.error('refresh', e)));
    ctx.waitUntil(autoConnect(env).catch((e) => console.error('autoConnect', e)));
    ctx.waitUntil(autoUpdate(env).catch((e) => console.error('autoUpdate', e)));
  },
};
