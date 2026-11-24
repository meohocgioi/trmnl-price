// Bot Telegram điều khiển plugin Bảng giá (chỉ chủ bot dùng được)
import { refresh, readAll, SOURCES } from './store.js';
import { buildView } from './view.js';
import { getSettings, saveSettings, DEFAULT_SETTINGS, P2P_MINS } from './settings.js';
import { checkUpdate } from './updater.js';
import { trmnlPreview } from './trmnl.js';
import { esc, stamp } from './util.js';
import { short } from './view.js';

const API = (env, m) => `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${m}`;

export async function tg(env, method, body) {
  const r = await fetch(API(env, method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
}

const kbMarkup = (kb) => (kb ? { reply_markup: { inline_keyboard: kb } } : {});

export function sendMsg(env, chatId, text, kb) {
  return tg(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...kbMarkup(kb) });
}

async function editOrSend(env, chatId, msgId, text, kb) {
  if (msgId) {
    const r = await tg(env, 'editMessageText', {
      chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...kbMarkup(kb),
    });
    if (r.ok || String(r.description || '').includes('not modified')) return r;
  }
  return sendMsg(env, chatId, text, kb);
}

async function sendPhotoBytes(env, chatId, bytes, type, caption, kb) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  fd.append('caption', caption);
  fd.append('parse_mode', 'HTML');
  if (kb) fd.append('reply_markup', JSON.stringify({ inline_keyboard: kb }));
  fd.append('photo', new Blob([bytes], { type: type || 'image/png' }), 'trmnl.png');
  return (await fetch(API(env, 'sendPhoto'), { method: 'POST', body: fd })).ok;
}

async function secretToken(env) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('trmnl-price:' + env.TELEGRAM_BOT_TOKEN));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

export async function ownerId(env) {
  return env.TELEGRAM_OWNER_ID || (await env.KV.get('owner'));
}

const COMMANDS = [
  { command: 'gia', description: '💰 Bảng giá hiện tại' },
  { command: 'preview', description: '🖼 Xem trước màn hình TRMNL' },
  { command: 'setting', description: '⚙️ Mua/Bán P2P, hạn mức, 1 hay 10 lượng' },
  { command: 'trmnl', description: '🔗 Polling URL cho TRMNL' },
  { command: 'update', description: '🔄 Cập nhật ngay: giá + code mới nhất' },
  { command: 'version', description: '🏷 Phiên bản đang chạy' },
  { command: 'help', description: '❓ Hướng dẫn' },
];

const MAIN_KB = [
  [{ text: '💰 Bảng giá', callback_data: 'gia' }, { text: '🖼 Preview TRMNL', callback_data: 'preview' }],
  [{ text: '⚙️ Cài đặt', callback_data: 'settings' }, { text: '🔄 Làm mới giá', callback_data: 'refresh' }],
];

export async function setupWebhook(env, origin, opts = {}) {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, error: 'Chưa có TELEGRAM_BOT_TOKEN' };
  const url = origin + '/tg';
  const me = await tg(env, 'getMe', {});
  if (!me.ok) return { ok: false, version: env.VERSION || null, bot: me };
  let info = await tg(env, 'getWebhookInfo', {});
  let webhook = { ok: true, skipped: 'đã đúng URL' };
  if (info?.result?.url !== url) {
    webhook = await tg(env, 'setWebhook', { url, secret_token: await secretToken(env), allowed_updates: ['message', 'callback_query'] });
    info = await tg(env, 'getWebhookInfo', {});
  }
  const commands = await tg(env, 'setMyCommands', { commands: COMMANDS });
  let notified = false;
  const owner = await ownerId(env);
  const hookOk = info?.result?.url === url;
  const botId = env.TELEGRAM_BOT_TOKEN.split(':')[0];
  if (opts.welcome && hookOk && owner && !(await env.KV.get('welcomed:' + botId))) {
    await sendMsg(env, owner, `👋 <b>Bot Bảng giá đã kết nối!</b>\n\nBấm 💰 Bảng giá để xem, ⚙️ Cài đặt để chọn giá Mua/Bán USDT và 1/10 lượng.`, MAIN_KB);
    await env.KV.put('welcomed:' + botId, '1');
  }
  if (owner && env.VERSION && (await env.KV.get('notifiedVersion')) !== env.VERSION) {
    await sendMsg(env, owner, `✅ <b>Đã cập nhật xong!</b>\n🏷 Phiên bản <code>${esc(env.VERSION)}</code>\n📝 ${esc(env.VERSION_MSG || '')}`, MAIN_KB);
    await env.KV.put('notifiedVersion', env.VERSION);
    notified = true;
  }
  const hook = info?.result || {};
  return {
    ok: hook.url === url, version: env.VERSION || null,
    bot: me?.result ? '@' + me.result.username : me,
    webhook_url: hook.url || null, webhook_last_error: hook.last_error_message || null,
    notified, webhook, commands,
  };
}

// ---------- Nội dung ----------
const pad = (s, n) => String(s).padStart(n);

function boardText(v) {
  const L = [`<b>💰 BẢNG GIÁ</b> · ${v.updated_full}`, ''];

  L.push(`<b>₮ USDT P2P · giá ${v.p2p.side}</b> <i>(hạn mức &gt; ${v.p2p.min}, bỏ QC)</i>`);
  if (v.p2p.has) {
    for (const a of v.p2p.ads) L.push(`${a.rank}. <b>${a.price}</b> · ${esc(a.name)} · <i>${a.limit}</i>`);
  } else L.push(`⚠️ <i>${esc(v.p2p.error)}</i>`);

  L.push('', '<b>💵 USD chợ đen</b>');
  L.push(v.black.has ? `Mua <b>${v.black.buy}</b> ${v.black.buy_ch} · Bán <b>${v.black.sell}</b> ${v.black.sell_ch}` : `⚠️ <i>${esc(v.black.error)}</i>`);
  if (v.usd_vcb) L.push(`<i>USD Vietcombank: ${v.usd_vcb.buy} / ${v.usd_vcb.sell}</i>`);

  L.push('', `<b>🥇 Vàng SJC</b> · ${v.unit_label} <i>(mua / bán)</i>`);
  if (v.gold.has) {
    L.push(`<code>Miếng ${pad(v.gold.bar.buy, 13)} ${pad(v.gold.bar.sell, 13)}</code>`);
    if (v.gold.ring) L.push(`<code>Nhẫn  ${pad(v.gold.ring.buy, 13)} ${pad(v.gold.ring.sell, 13)}</code>`);
  } else L.push(`⚠️ <i>${esc(v.gold.error)}</i>`);

  L.push('', `<b>🥈 Bạc</b> · ${v.unit_label} <i>(mua / bán)</i>`);
  for (const b of v.silver) {
    L.push(b.has ? `<code>${b.name.padEnd(11)} ${pad(b.buy, 11)} ${pad(b.sell, 11)}</code>` : `${b.name}: ⚠️ <i>${esc(b.error)}</i>`);
  }

  L.push('', '<b>🌍 Thế giới</b> (USD/oz)');
  for (const w of v.world) L.push(`${w.name} (${w.short}): <b>${w.price}</b> ${w.pct}`);

  L.push('', '<b>💱 Ngoại tệ Vietcombank</b> <i>(mua / bán)</i>');
  for (const f of v.fx) L.push(`<code>${f.code} ${pad(f.buy, 8)} ${pad(f.sell, 8)}</code>  ${f.name}`);

  L.push('', '<b>⛽ Xăng (PVOIL)</b>');
  if (v.fuel.has) {
    L.push(`${esc(v.fuel.name)}: <b>${v.fuel.price} đ/lít</b> ${v.fuel.change} · từ ${v.fuel.since}`);
    if (v.fuel.e5) L.push(`${esc(v.fuel.e5.name)}: ${v.fuel.e5.price} đ/lít ${v.fuel.e5.change}`);
  } else L.push(`⚠️ <i>${esc(v.fuel.error)}</i>`);

  if (v.warn_count) L.push('', `⚠️ <i>${esc(v.warn)}</i>`);
  return L.join('\n');
}

function settingsView(s, note = '') {
  const tick = (b) => (b ? '✅ ' : '');
  const text =
    `<b>⚙️ Cài đặt</b>\n\n` +
    `<b>₮ USDT P2P:</b> hiện giá <b>${s.p2pSide === 'SELL' ? 'BÁN' : 'MUA'}</b> · 3 quảng cáo đầu, bỏ Promoted Ad, hạn mức tối đa &gt; <b>${short(s.p2pMin)}</b>\n` +
    `<b>🥇 Vàng / 🥈 Bạc:</b> giá cho <b>${s.unit === 10 ? '10 lượng' : '1 lượng'}</b>\n` +
    `<b>⛽ Xăng:</b> E10${s.showE5 ? ' + E5' : ''}\n\n` +
    `<i>TRMNL đổi ở lần làm mới tới (≤ 15 phút) — hoặc /preview để xem ngay.</i>` +
    (note ? `\n\n${note}` : '');
  const kb = [
    [{ text: `${tick(s.p2pSide === 'SELL')}Giá BÁN USDT`, callback_data: 'set:p2pSide:SELL' }, { text: `${tick(s.p2pSide === 'BUY')}Giá MUA USDT`, callback_data: 'set:p2pSide:BUY' }],
    P2P_MINS.map((m) => ({ text: `${tick(s.p2pMin === m)}> ${short(m)}`, callback_data: `set:p2pMin:${m}` })),
    [{ text: `${tick(s.unit === 1)}1 lượng`, callback_data: 'set:unit:1' }, { text: `${tick(s.unit === 10)}10 lượng`, callback_data: 'set:unit:10' }],
    [{ text: `${s.showE5 ? '☑️' : '⬜'} Hiện thêm xăng E5`, callback_data: 'set:showE5:toggle' }],
    [{ text: '🖼 Xem trước TRMNL', callback_data: 'preview' }, { text: '💰 Bảng giá', callback_data: 'gia' }],
  ];
  return { text, kb };
}

const HELP =
  `<b>❓ Hướng dẫn</b>\n\n` +
  `/gia – bảng giá hiện tại\n` +
  `/preview – xem trước màn hình TRMNL (đúng như lần refresh tới)\n` +
  `/preview all – xem cả 4 cỡ (full, nửa ngang, nửa dọc, 1/4)\n` +
  `/setting – giá Mua/Bán USDT, hạn mức P2P, giá vàng/bạc 1 hay 10 lượng\n` +
  `/trmnl – Polling URL để cài plugin trên TRMNL\n` +
  `/update – lấy lại giá ngay + cập nhật code mới nhất\n` +
  `/version – phiên bản đang chạy\n\n` +
  `<b>Nguồn:</b> Binance P2P · tygiausd.org (USD chợ đen, bảng giá SJC) · DOJI · Phú Quý · TradingView (OANDA:XAUUSD, TVC:SILVER) · Vietcombank · PVOIL.\n` +
  `Giá tự làm mới: P2P + thế giới 5 phút, SJC/chợ đen 15 phút, bạc/ngoại tệ 30 phút, xăng 1 giờ.`;

const VIEW_NAME = {
  markup_full: 'Toàn màn hình', markup_half_horizontal: 'Nửa ngang',
  markup_half_vertical: 'Nửa dọc', markup_quadrant: '1/4 màn hình',
};

async function doBoard(env, chatId, msgId) {
  const v = buildView(await readAll(env), await getSettings(env));
  return editOrSend(env, chatId, msgId, boardText(v), MAIN_KB);
}

async function doRefresh(env, chatId, msgId) {
  const wait = msgId ? null : await sendMsg(env, chatId, '🔄 Đang lấy lại tất cả giá… (~20 giây)');
  const r = await refresh(env, { force: true });
  const bad = Object.entries(r.result).filter(([, x]) => x !== 'ok').map(([k, x]) => `• ${SOURCES[k].label}: ${esc(x.replace(/^ERR /, ''))}`);
  const v = buildView(r.data, r.settings);
  const head = bad.length ? `⚠️ <b>Một số nguồn lỗi:</b>\n${bad.join('\n')}\n\n` : '✅ Đã lấy lại tất cả giá.\n\n';
  return editOrSend(env, chatId, msgId || wait?.result?.message_id, head + boardText(v), MAIN_KB);
}

async function doPreview(env, chatId, all) {
  if (!env.TRMNL_MCP_KEY) {
    return sendMsg(env, chatId, '⚠️ Chưa có secret <code>TRMNL_MCP_KEY</code> (MCP API key của plugin trên TRMNL).\nThêm vào GitHub Secrets rồi bấm /update.');
  }
  const wait = await sendMsg(env, chatId, '⏳ Đang nhờ TRMNL render màn hình với dữ liệu hiện tại… (~15–30 giây)');
  const views = all ? ['markup_full', 'markup_half_horizontal', 'markup_half_vertical', 'markup_quadrant'] : ['markup_full'];
  try {
    const imgs = await trmnlPreview(env, views);
    for (let i = 0; i < imgs.length; i++) {
      const im = imgs[i];
      const cap = i === 0
        ? `🖼 <b>Preview TRMNL</b> · ${VIEW_NAME[im.view] || im.view}\n<i>Đúng như màn hình sẽ hiện ở lần TRMNL refresh tới.</i>`
        : `🖼 ${VIEW_NAME[im.view] || im.view}`;
      await sendPhotoBytes(env, chatId, im.bytes, im.type, cap, i === imgs.length - 1 ? MAIN_KB : undefined);
    }
    if (wait?.result?.message_id) await tg(env, 'deleteMessage', { chat_id: chatId, message_id: wait.result.message_id });
  } catch (e) {
    await editOrSend(env, chatId, wait?.result?.message_id, `❌ Không lấy được preview.\n<code>${esc(e.message).slice(0, 500)}</code>`, MAIN_KB);
  }
}

// ---------- Xử lý update ----------
export async function handleTelegram(req, env) {
  if (!env.TELEGRAM_BOT_TOKEN) return new Response('no token', { status: 503 });
  if (req.headers.get('x-telegram-bot-api-secret-token') !== (await secretToken(env))) {
    return new Response('forbidden', { status: 403 });
  }
  const upd = await req.json();
  const origin = new URL(req.url).origin;
  const dk = 'upd:' + upd.update_id;
  if (await env.KV.get(dk)) return new Response('dup');
  await env.KV.put(dk, '1', { expirationTtl: 600 });
  try {
    await processUpdate(env, upd, origin);
  } catch (e) {
    console.error('telegram', e);
  }
  return new Response('ok');
}

async function processUpdate(env, upd, origin) {
  const msg = upd.message || upd.callback_query?.message;
  const from = upd.message?.from || upd.callback_query?.from;
  if (!msg || !from) return;
  const chatId = msg.chat.id;

  let owner = await ownerId(env);
  if (!owner) {
    owner = String(from.id);
    await env.KV.put('owner', owner);
  }
  if (String(from.id) !== String(owner)) {
    if (upd.message) await sendMsg(env, chatId, '⛔ Bot này là bot riêng.');
    return;
  }

  if (upd.callback_query) {
    const data = upd.callback_query.data || '';
    await tg(env, 'answerCallbackQuery', { callback_query_id: upd.callback_query.id });
    const mid = msg.message_id;
    if (data === 'gia') return doBoard(env, chatId, mid);
    if (data === 'refresh') return doRefresh(env, chatId, mid);
    if (data === 'preview') return doPreview(env, chatId, false);
    if (data === 'settings') { const v = settingsView(await getSettings(env)); return editOrSend(env, chatId, mid, v.text, v.kb); }
    if (data.startsWith('set:')) {
      const [, k, val] = data.split(':');
      const s = await getSettings(env);
      if (!(k in DEFAULT_SETTINGS)) return;
      if (k === 'showE5') s.showE5 = !s.showE5;
      else if (k === 'p2pSide') s.p2pSide = val === 'BUY' ? 'BUY' : 'SELL';
      else if (k === 'p2pMin') s.p2pMin = P2P_MINS.includes(Number(val)) ? Number(val) : DEFAULT_SETTINGS.p2pMin;
      else if (k === 'unit') s.unit = val === '10' ? 10 : 1;
      await saveSettings(env, s);
      let note = '✅ Đã lưu.';
      if (k.startsWith('p2p')) {
        const r = await refresh(env, { only: ['p2p'], force: true });
        if (r.result.p2p !== 'ok') note = `✅ Đã lưu. ⚠️ Chưa lấy được giá P2P mới: <i>${esc(String(r.result.p2p).replace(/^ERR /, ''))}</i>`;
      }
      const v = settingsView(s, note);
      return editOrSend(env, chatId, mid, v.text, v.kb);
    }
    return;
  }

  const text = (msg.text || '').trim();
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = (cmdRaw || '').toLowerCase().replace(/@.*$/, '');
  const arg = rest.join(' ').trim();

  switch (cmd) {
    case '/start':
      return sendMsg(env, chatId,
        `<b>💰 Bảng giá → TRMNL</b>\n\nHiện lên TRMNL: USDT P2P Binance, USD chợ đen, vàng SJC, bạc DOJI + Phú Quý, vàng/bạc thế giới, ngoại tệ (CNY, JPY, GBP), xăng E10.\n\nBấm ⚙️ Cài đặt để chọn giá Mua/Bán USDT và 1/10 lượng.`, MAIN_KB);
    case '/help':
      return sendMsg(env, chatId, HELP, MAIN_KB);
    case '/gia':
    case '/status':
      return doBoard(env, chatId, null);
    case '/refresh':
      return doRefresh(env, chatId, null);
    case '/setting':
    case '/settings': {
      const v = settingsView(await getSettings(env));
      return sendMsg(env, chatId, v.text, v.kb);
    }
    case '/preview':
      return doPreview(env, chatId, /^(all|tat ca|tất cả)$/i.test(arg));
    case '/trmnl':
      return sendMsg(env, chatId, `<b>🖼 Cài đặt TRMNL</b>\n\nStrategy: <b>Polling</b>\nPolling URL:\n<code>${origin}/trmnl</code>`);
    case '/version':
      return sendMsg(env, chatId, `🏷 Phiên bản đang chạy: <code>${esc(env.VERSION || 'chưa rõ')}</code>\n📝 ${esc(env.VERSION_MSG || '')}`);
    case '/update': {
      const wait = await sendMsg(env, chatId, '🔄 <b>Đang cập nhật…</b>');
      const wid = wait?.result?.message_id;
      const L = ['🔄 <b>Cập nhật ngay</b>', ''];
      const r = await refresh(env, { force: true });
      const bad = Object.entries(r.result).filter(([, x]) => x !== 'ok');
      L.push(bad.length ? `⚠️ Giá: ${Object.keys(r.result).length - bad.length}/${Object.keys(r.result).length} nguồn OK (lỗi: ${bad.map(([k]) => SOURCES[k].label).join(', ')})` : '✅ Giá: lấy lại xong tất cả nguồn');
      if (!env.GH_TOKEN) L.push('⚠️ Chưa có secret <code>GH_TOKEN</code> nên không cập nhật code được.');
      else {
        try {
          const u = await checkUpdate(env, { force: true });
          L.push(u.isNew
            ? `🚀 Có code mới <code>${esc(u.latest.sha)}</code> (${esc(u.latest.msg)}) — đang deploy, bot báo ✅ khi xong`
            : `✅ Code đã mới nhất (<code>${esc(u.current || '?')}</code>) — vẫn deploy lại cho chắc`);
        } catch (e) { L.push(`❌ Kiểm tra code lỗi: ${esc(e.message)}`); }
      }
      L.push('', '<i>Gõ /gia hoặc /preview để xem.</i>');
      return editOrSend(env, chatId, wid, L.join('\n'), MAIN_KB);
    }
    default:
      if (cmd) return sendMsg(env, chatId, '🤔 Không hiểu lệnh.\n\n' + HELP, MAIN_KB);
  }
}

export { boardText, stamp };
