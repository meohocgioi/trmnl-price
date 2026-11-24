// Xem trước màn hình TRMNL ngay trong bot: dựng markup Liquid với dữ liệu hiện tại
// rồi chụp ảnh bằng trình duyệt ảo của Cloudflare (Browser Rendering) — không cần key TRMNL.
import puppeteer from '@cloudflare/puppeteer';
import { Liquid } from 'liquidjs';
import SHARED from '../trmnl/shared.liquid';
import FULL from '../trmnl/full.liquid';
import HH from '../trmnl/half_horizontal.liquid';
import HV from '../trmnl/half_vertical.liquid';
import Q from '../trmnl/quadrant.liquid';

export const VIEWS = {
  markup_full: { tpl: FULL, w: 800, h: 480 },
  markup_half_horizontal: { tpl: HH, w: 800, h: 240 },
  markup_half_vertical: { tpl: HV, w: 400, h: 480 },
  markup_quadrant: { tpl: Q, w: 400, h: 240 },
};

const engine = new Liquid();

export async function renderHtml(view, data) {
  const v = VIEWS[view];
  const body = await engine.parseAndRender(SHARED + v.tpl, data);
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://usetrmnl.com/css/latest/plugins.css">
<style>html,body{margin:0;background:#fff}body{width:${v.w}px;height:${v.h}px;overflow:hidden}.layout{width:${v.w}px;height:${v.h}px}</style>
</head><body>${body}</body></html>`;
}

// Trả về [{ view, bytes, type }]
export async function localPreview(env, data, views = ['markup_full']) {
  if (!env.BROWSER) throw new Error('Thiếu Browser Rendering');
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const out = [];
    for (const view of views) {
      const v = VIEWS[view];
      const page = await browser.newPage();
      await page.setViewport({ width: v.w, height: v.h, deviceScaleFactor: 1 });
      await page.setContent(await renderHtml(view, data), { waitUntil: 'networkidle0', timeout: 20000 });
      const bytes = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: v.w, height: v.h } });
      out.push({ view, bytes, type: 'image/png' });
      await page.close();
    }
    return out;
  } finally {
    await browser.close().catch(() => {});
  }
}
