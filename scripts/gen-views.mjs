// Tạo markup TRMNL:
//  - shared.liquid = CSS (_style) + giao diện (_body) gói trong biến pb_body
//  - full / half_horizontal / half_vertical / quadrant = 1 dòng + class cỡ màn hình
// Sửa giao diện: sửa trmnl/_style.liquid, trmnl/_body.liquid rồi chạy `node scripts/gen-views.mjs`
import { readFileSync, writeFileSync } from 'node:fs';

const rd = (f) => readFileSync('trmnl/' + f, 'utf8').replace(/^\{% comment %\}[\s\S]*?\{% endcomment %\}\n/, '').trimEnd();
const shared = [rd('_style.liquid'), `{% capture pb_body %}\n${rd('_body.liquid')}\n{% endcapture %}`].join('\n') + '\n';
writeFileSync('trmnl/shared.liquid', shared);
const views = { full: 'sz-full', half_horizontal: 'sz-hh', half_vertical: 'sz-hv', quadrant: 'sz-q' };
for (const [name, cls] of Object.entries(views)) {
  writeFileSync(`trmnl/${name}.liquid`, `<div class="layout" style="padding:0;"><div class="${cls}" style="width:100%;height:100%;">{{ pb_body }}</div></div>\n`);
}
console.log('ok: shared (' + shared.length + ' ký tự) + 4 views');
