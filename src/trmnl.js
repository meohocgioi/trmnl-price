// Gọi máy chủ MCP của TRMNL bằng plugin key (secret TRMNL_MCP_KEY)
// để làm mới dữ liệu plugin và chụp ảnh xem trước bằng chính bộ render của TRMNL.
const ENDPOINT = 'https://trmnl.com/mcp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseBody(text, type) {
  // Máy chủ có thể trả JSON thường hoặc SSE ("data: {...}")
  if ((type || '').includes('text/event-stream') || text.startsWith('event:') || text.startsWith('data:')) {
    const datas = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
    for (let i = datas.length - 1; i >= 0; i--) {
      try {
        const j = JSON.parse(datas[i]);
        if (j.result || j.error) return j;
      } catch {}
    }
    throw new Error('SSE không có kết quả');
  }
  return JSON.parse(text);
}

class Mcp {
  constructor(key) {
    this.url = `${ENDPOINT}?api_key=${encodeURIComponent(key)}`;
    this.session = null;
    this.n = 0;
  }

  async rpc(method, params, notify = false) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    };
    if (this.session) headers['mcp-session-id'] = this.session;
    const body = { jsonrpc: '2.0', method, ...(params ? { params } : {}) };
    if (!notify) body.id = ++this.n;
    const r = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body) });
    const sid = r.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (notify) return null;
    const text = await r.text();
    if (!r.ok) throw new Error(`TRMNL HTTP ${r.status}: ${text.slice(0, 200)}`);
    const j = parseBody(text, r.headers.get('content-type'));
    if (j.error) throw new Error(`TRMNL: ${j.error.message || JSON.stringify(j.error)}`);
    return j.result;
  }

  async init() {
    await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'trmnl-price-bot', version: '1.0' },
    });
    await this.rpc('notifications/initialized', null, true).catch(() => {});
  }

  async tool(name, args = {}) {
    const res = await this.rpc('tools/call', { name, arguments: args });
    if (res?.isError) {
      const msg = (res.content || []).map((c) => c.text).filter(Boolean).join(' ');
      throw new Error(`${name}: ${msg.slice(0, 300)}`);
    }
    return res;
  }

  // Công cụ chạy nền: trả job_id -> hỏi AsyncResultTool tới khi xong
  async job(name, args = {}, maxWaitMs = 40000) {
    const first = await this.tool(name, args);
    const jobId = jsonOf(first)?.job_id;
    if (!jobId) return first; // trả kết quả luôn
    const t0 = Date.now();
    while (Date.now() - t0 < maxWaitMs) {
      await sleep(2500);
      const r = await this.tool('AsyncResultTool', { job_id: jobId });
      const j = jsonOf(r);
      if (hasImage(r) || j?.status === 'complete') return r;
      if (j?.status === 'failed') throw new Error(`${name} thất bại: ${JSON.stringify(j).slice(0, 200)}`);
    }
    throw new Error(`${name}: quá thời gian chờ`);
  }
}

function jsonOf(res) {
  for (const c of res?.content || []) {
    if (c.type === 'text') {
      try { return JSON.parse(c.text); } catch {}
    }
  }
  return res?.structuredContent || null;
}

const hasImage = (res) => (res?.content || []).some((c) => c.type === 'image');

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Làm mới dữ liệu plugin (giống TRMNL tự lấy dữ liệu ở lần refresh tới)
 * rồi chụp ảnh xem trước. Trả về [{ view, bytes, type }]
 */
export async function trmnlPreview(env, views = ['markup_full']) {
  if (!env.TRMNL_MCP_KEY) throw new Error('Chưa có secret TRMNL_MCP_KEY');
  const m = new Mcp(env.TRMNL_MCP_KEY);
  await m.init();
  await m.job('IntegrationsRefreshDataTool');
  const shot = await m.job('MarkupsScreenshotTool', { views, device_models: [] });
  const imgs = (shot.content || []).filter((c) => c.type === 'image');
  if (!imgs.length) throw new Error('TRMNL không trả ảnh: ' + JSON.stringify(jsonOf(shot) || shot).slice(0, 200));
  return imgs.map((c, i) => ({ view: views[i] || views[0], bytes: b64ToBytes(c.data), type: c.mimeType || 'image/png' }));
}
