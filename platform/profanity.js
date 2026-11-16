'use strict';

// Rude / offensive word filter for player names (Latvian, English, and the Russian slang common in Latvia).
//
//   isOffensive(name) -> true when the name contains a blocked word
//
// Before matching, a name is "folded" so simple disguises don't help: lower case, accents removed
// (ā→a, ļ→l, š→s), look-alike digits and symbols turned into letters (0→o, 1→i, 3→e, 4→a, 5→s,
// 7→t, 8→b, @→a, $→s), separators dropped, and repeated letters squeezed ("piiimpis" → "pimpis").
//
// Two kinds of entries, to avoid blocking innocent names (the "Scunthorpe problem"):
//   ANYWHERE  roots that are rude wherever they appear, also inside longer names ("melnspimpis")
//   WORD      short or ambiguous roots that only count as a word of their own, optionally with a usual
//             ending: "dick" blocks "Dick" and "dicks" but not "Dickens"; "nazi" blocks "Nazi" but not
//             "Ignazio"; "pist" blocks "pist" but not "Pistole".
//
// Extra words without a code change: BLOCKED_NAME_WORDS="word1,word2" (matched anywhere).
// Exceptions (a real name that trips the filter): ALLOWED_NAMES="Name One,Name Two" (exact names).

const ANYWHERE = [
  // Latvian
  'pimpis', 'pimpja', 'pimpim', 'pimpi', 'pizd', 'pizģ', 'pizg', 'dirsa', 'dirsā', 'dirst', 'mauka', 'maukas',
  'maukai', 'maukot', 'pederast', 'pēderast', 'pidar', 'pidor', 'nēģer', 'negeris', 'sūdabrāl', 'sudabral',
  'mīzal', 'jobans', 'jobaņ', 'jebat', 'jeban', 'jebal', 'hujņ', 'hujn', 'pautu', 'pauti', 'loceklis', 'sperm',
  'ejakul', 'izdrāz', 'izdraz', 'drāzt', 'drazt',
  // Russian slang
  'blyat', 'bljat', 'bljad', 'blyad', 'pizdec', 'nahuj', 'nahui', 'nahuy', 'mudak', 'gandon', 'zalupa', 'shluh',
  'šļuh', 'dolboeb', 'dolbojob', 'ebalo', 'pohuj', 'pohui',
  // English
  'fuck', 'fuk', 'fck', 'motherf', 'shit', 'bitch', 'pussy', 'penis', 'vagina', 'whore', 'slut', 'nigger',
  'faggot', 'retard', 'porn', 'asshole', 'arsehole', 'dickhead', 'cocksuck', 'blowjob', 'handjob', 'jizz',
  'twat', 'bollock', 'dildo', 'pedophil', 'paedophil', 'rapist', 'hitler', 'siegheil', 'cumshot', 'orgasm',
  'masturb',
];

const WORD = [
  // Latvian
  'pist', 'pisa', 'pisu', 'pisiens', 'pisties', 'sūds', 'sūdi', 'sūdu', 'kuce', 'pidrs', 'pediņš', 'pedis',
  'pupi', 'dauns', 'dauņi', 'drāz',
  // Russian slang
  'huj', 'hui', 'huy', 'blad', 'blja', 'suka', 'eban', 'pidr', 'pzdc',
  // English
  'dick', 'cock', 'fag', 'ass', 'arse', 'cum', 'sex', 'anal', 'anus', 'rape', 'tit', 'tits', 'boob', 'piss',
  'bastard', 'prick', 'knob', 'nazi', 'nigga', 'cunt', 'wank', 'horny', 'xxx',
];
// Endings a WORD root may carry and still count as that word (Latvian and English inflections).
const WORD_ENDINGS = ['', 's', 'is', 'a', 'as', 'i', 'u', 'e', 'es', 'ai', 'am', 'iem', 'ām', 'am', 'er', 'ers', 'ing', 'ed', 'y', 'ie', 'ies', 'z', 'ā', 'ē'];

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'i', '€': 'e' };

function stripAccents(s) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}
function deleet(s) {
  return s.replace(/[0134578@$!|€]/g, (c) => LEET[c] || c);
}
const squeeze = (s) => s.replace(/(.)\1+/g, '$1');

// One canonical form for a word list entry (same folding as names, minus the separators step).
function foldWord(w) {
  return squeeze(stripAccents(String(w).toLowerCase()));
}

const anywhere = [...new Set(ANYWHERE.concat(
  String(process.env.BLOCKED_NAME_WORDS || '').split(',').map((w) => w.trim()).filter(Boolean)
).map(foldWord))].filter((w) => w.length >= 3);
// WORD entries are not squeezed ("boob" must not turn into "bob" and block the name Bobs)
const words = new Set(WORD.map((w) => stripAccents(w.toLowerCase())));
const endings = [...new Set(WORD_ENDINGS.map((e) => stripAccents(e.toLowerCase())))].sort((a, b) => b.length - a.length);
const allowed = new Set(String(process.env.ALLOWED_NAMES || '').split(',').map((n) => n.trim()).filter(Boolean));

function isWord(token) {
  if (!token) return false;
  for (const end of endings) {
    if (end && !token.endsWith(end)) continue;
    const root = end ? token.slice(0, -end.length) : token;
    if (words.has(root)) return true;
  }
  return false;
}

/** True when the name contains a blocked word (in any of the disguises described above). */
function isOffensive(name) {
  const raw = String(name || '').trim();
  if (!raw || allowed.has(raw)) return false;
  // camelCase / PascalCase also separate words ("BigDick" -> "big dick")
  const spaced = raw.replace(/([a-zāčēģīķļņšūž])([A-ZĀČĒĢĪĶĻŅŠŪŽ])/g, '$1 $2');
  const base = stripAccents(deleet(spaced.toLowerCase()));
  // the whole name glued together: catches "m e l n s p i m p i s", "p.i.z.d.a", "fu_ck"
  const glued = base.replace(/[^a-z]/g, '');
  for (const form of [glued, squeeze(glued)]) {
    if (anywhere.some((w) => form.includes(w))) return true;
  }
  // word by word for the short / ambiguous roots
  const tokens = base.split(/[^a-z]+/).filter(Boolean);
  if (tokens.some((t) => isWord(t) || isWord(squeeze(t)))) return true;
  // a short name that is nothing but a rude word glued from single letters ("d i c k")
  if (raw.length <= 12 && (isWord(glued) || isWord(squeeze(glued)))) return true;
  return false;
}

module.exports = { isOffensive };
