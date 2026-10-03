'use strict';
// Keeps the three parts apart. Run: npm run check
//   platform/      may not require anything from games/ or site/
//   games/duraks/  may not require games/meli/ (and the other way round); may use platform/
//   games/meli/    may not require games/duraks/; may use platform/ only through server.js (it gets accounts passed in)
//   site/          has no server code
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const RULES = [
  { from: 'platform', forbid: ['games', 'site'] },
  { from: 'games/duraks', forbid: ['games/meli', 'site'] },
  { from: 'games/meli', forbid: ['games/duraks', 'platform', 'site'] },
];
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'data') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js') && !p.includes(path.sep + 'public' + path.sep)) out.push(p);
  }
  return out;
}
let bad = 0;
for (const rule of RULES) {
  const base = path.join(ROOT, rule.from);
  if (!fs.existsSync(base)) continue;
  for (const file of walk(base)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/require\((['"])(\.[^'"]*)\1\)/g)) {
      const target = path.relative(ROOT, path.resolve(path.dirname(file), m[2])).split(path.sep).join('/');
      for (const f of rule.forbid) {
        if (target === f || target.startsWith(f + '/')) { bad++; console.log(`✗ ${path.relative(ROOT, file)} requires ${target}  (${rule.from} must not use ${f})`); }
      }
    }
  }
}
console.log(bad ? `${bad} boundary problem(s)` : 'boundaries ok: platform / games/duraks / games/meli / site are independent');
process.exit(bad ? 1 : 0);
