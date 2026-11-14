'use strict';
// Card faces and backs drawn as SVG in the browser — no image files.
// Design: cream paper, Georgia, gold frames; courts as a large monogram
// (crown / tiara / cap), aces as one big pip, two suit colours, and a
// petrol-blue back with a fine diagonal grid and a gold "U" medallion.
//
// install() turns the 52 faces into CSS background images scoped to
// <html data-card-deck="svg">, so the rest of the game keeps using the same
// .card-face-<rank>-<suit> classes as with the PNG sprite.
window.DuraksSvgCards = (function () {
  const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
  const PAPER = '#faf6ec';
  const EDGE = '#cdbf9f';
  const GOLD = '#c9a24b';
  const INK = '#1d232a';
  const RED = '#b3261e';
  const FONT = "Georgia,'Times New Roman',serif";

  function col(s) { return (s === 'hearts' || s === 'diamonds') ? RED : INK; }

  // suit symbols in a 100x100 box
  const PIP = {
    hearts: '<path d="M50 90C22 68 4 52 4 31 4 15 16 5 30 5c10 0 17 6 20 14 3-8 10-14 20-14 14 0 26 10 26 26 0 21-18 37-46 59z"/>',
    diamonds: '<path d="M50 2 88 50 50 98 12 50z"/>',
    spades: '<path d="M50 4c12 19 46 36 46 59 0 15-11 25-25 25-8 0-14-4-17-10 1 9 5 16 13 20H33c8-4 12-11 13-20-3 6-9 10-17 10C15 88 4 78 4 63 4 40 38 23 50 4z"/>',
    clubs: '<circle cx="50" cy="27" r="21"/><circle cx="27" cy="59" r="21"/><circle cx="73" cy="59" r="21"/><path d="M45 52h10c0 22 4 34 15 44H30c11-10 15-22 15-44z"/>'
  };
  function pip(s, x, y, size, flip) {
    return '<g transform="translate(' + x + ' ' + y + ')' + (flip ? ' rotate(180)' : '') +
      ' translate(' + (-size / 2) + ' ' + (-size / 2) + ') scale(' + (size / 100) + ')" fill="' + col(s) + '">' + PIP[s] + '</g>';
  }

  // pip positions on a 240-wide field (shifted +5 into the 250-wide card)
  const L = 74, C = 120, R = 166;
  const LAYOUT = {
    '2': [[C, 92], [C, 258]],
    '3': [[C, 92], [C, 175], [C, 258]],
    '4': [[L, 92], [R, 92], [L, 258], [R, 258]],
    '5': [[L, 92], [R, 92], [C, 175], [L, 258], [R, 258]],
    '6': [[L, 92], [R, 92], [L, 175], [R, 175], [L, 258], [R, 258]],
    '7': [[L, 92], [R, 92], [C, 133], [L, 175], [R, 175], [L, 258], [R, 258]],
    '8': [[L, 92], [R, 92], [C, 133], [L, 175], [R, 175], [C, 217], [L, 258], [R, 258]],
    '9': [[L, 92], [R, 92], [L, 147], [R, 147], [C, 175], [L, 203], [R, 203], [L, 258], [R, 258]],
    '10': [[L, 92], [R, 92], [C, 120], [L, 147], [R, 147], [L, 203], [R, 203], [C, 230], [L, 258], [R, 258]]
  };

  function corner(rank, s) {
    const ten = rank === '10';
    return '<text x="29" y="52" text-anchor="middle" font-family="' + FONT + '" font-weight="700" font-size="' + (ten ? 38 : 48) + '"' +
      (ten ? ' letter-spacing="-4"' : '') + ' fill="' + col(s) + '">' + rank + '</text>' + pip(s, 29, 80, 30);
  }

  const EMBLEM = {
    K: '<path d="M8 82V34l21 20 21-36 21 36 21-20v48z"/><rect x="8" y="84" width="84" height="10" rx="2"/>',
    Q: '<path d="M8 88C14 52 86 52 92 88z"/><circle cx="50" cy="38" r="9"/><circle cx="24" cy="56" r="7"/><circle cx="76" cy="56" r="7"/>',
    J: '<ellipse cx="46" cy="66" rx="40" ry="17"/><path d="M58 52C74 26 90 16 98 8 92 30 82 44 66 56z"/><circle cx="46" cy="46" r="6"/>'
  };
  function court(r, s) {
    const c = col(s);
    return '<rect x="46" y="70" width="148" height="210" rx="10" fill="' + c + '" fill-opacity=".06" stroke="' + GOLD + '" stroke-width="2.5"/>' +
      '<rect x="53" y="77" width="134" height="196" rx="7" fill="none" stroke="' + GOLD + '" stroke-width="1" stroke-opacity=".7"/>' +
      '<g transform="translate(93 91) scale(.54)" fill="' + GOLD + '">' + EMBLEM[r] + '</g>' +
      '<text x="120" y="222" text-anchor="middle" font-family="' + FONT + '" font-weight="700" font-size="104" fill="' + c + '">' + r + '</text>' +
      pip(s, 120, 252, 24);
  }

  function face(rank, s) {
    let body;
    if (LAYOUT[rank]) body = LAYOUT[rank].map(function (p) { return pip(s, p[0], p[1], rank === '10' ? 38 : 42, p[1] > 175); }).join('');
    else if (rank === 'A') body = pip(s, 120, 175, s === 'spades' ? 112 : 104);
    else body = court(rank, s);
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350">' +
      '<rect x="1.5" y="1.5" width="247" height="347" rx="16" fill="' + PAPER + '" stroke="' + EDGE + '" stroke-width="3"/>' +
      corner(rank, s) + '<g transform="rotate(180 125 175)">' + corner(rank, s) + '</g>' +
      '<g transform="translate(5 0)">' + body + '</g></svg>';
  }

  function back() {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350"><defs>' +
      '<pattern id="g" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
      '<path d="M0 6h12M6 0v12" stroke="#faf6ec" stroke-opacity=".28" stroke-width="1.2"/></pattern></defs>' +
      '<rect x="1.5" y="1.5" width="247" height="347" rx="16" fill="' + PAPER + '" stroke="' + EDGE + '" stroke-width="3"/>' +
      '<rect x="14" y="14" width="222" height="322" rx="10" fill="#235d7a"/>' +
      '<rect x="14" y="14" width="222" height="322" rx="10" fill="url(#g)"/>' +
      '<rect x="22" y="22" width="206" height="306" rx="7" fill="none" stroke="#e2c374" stroke-width="2.5"/>' +
      '<circle cx="125" cy="175" r="40" fill="#143a4d" stroke="#e2c374" stroke-width="3"/>' +
      '<text x="125" y="192" text-anchor="middle" font-family="' + FONT + '" font-weight="700" font-size="48" fill="#e2c374">U</text></svg>';
  }

  function dataUrl(svg) { return 'data:image/svg+xml,' + encodeURIComponent(svg); }
  const backUrl = dataUrl(back());
  let installed = false;

  function install() {
    if (installed) return;
    installed = true;
    let css = '[data-card-deck="svg"] .card-face{background-size:100% 100%;background-position:0 0;background-color:transparent;}' +
      '[data-card-deck="svg"] .card-back-mini,[data-card-deck="svg"] .meli .back{background-image:url("' + backUrl + '");background-size:100% 100%;}';
    SUITS.forEach(function (s) {
      RANKS.forEach(function (r) {
        css += '[data-card-deck="svg"] .card-face-' + r + '-' + s + '{background-image:url("' + dataUrl(face(r, s)) + '");}';
      });
    });
    const style = document.createElement('style');
    style.id = 'svgCardStyles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // The deck pile is an <img>; swap its picture between the PNG stack and the SVG back.
  function setStackImages(useSvg) {
    document.querySelectorAll('.deck-stack-img').forEach(function (img) {
      if (!img.dataset.pngSrc) img.dataset.pngSrc = img.getAttribute('src');
      const want = useSvg ? backUrl : img.dataset.pngSrc;
      if (img.getAttribute('src') !== want) img.setAttribute('src', want);
    });
  }

  return { install: install, setStackImages: setStackImages, face: face, back: back };
})();
