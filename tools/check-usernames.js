#!/usr/bin/env node
'use strict';
// Preview of the rude-name filter on existing accounts — changes nothing.
//
//   node tools/check-usernames.js path/to/users.json
//
// Lists every account name the filter (platform/profanity.js) would rename on the next server start.
// A real name listed by mistake can be exempted with ALLOWED_NAMES="Name1,Name2" (exact names),
// both here and on the server.
const fs = require('fs');
const { isOffensive } = require('../platform/profanity');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node tools/check-usernames.js path/to/users.json');
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const names = Object.keys((data && data.users) || data || {});
const hits = names.filter(isOffensive);
console.log(`${names.length} accounts checked, ${hits.length} would be renamed:`);
for (const n of hits) console.log('  ' + n);
