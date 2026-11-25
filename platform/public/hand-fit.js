// Keeps the player's hand clear of the deck on the card table (Duraks, Meļi).
// With a big hand the fanned cards reach under the deck at the bottom-left corner. Then the deck moves
// to the mirror spot on the right, the hand is centred in the room left of it, and if it still doesn't
// fit, the cards overlap more (never so much that a card's corner with its rank and suit is hidden).
// Nothing changes while the hand fits: the table looks exactly as before.
//
//   UzsHandFit.fit({ area, hand, deck })
//     area: the table element both sit in (their offsetParent), hand: the row of cards,
//     deck: the deck element (positioned with left/top, may be a 0×0 anchor with rotated children)
(function () {
  'use strict';

  function unionRect(el) {
    const r = el.getBoundingClientRect();
    let l = r.left, t = r.top, rt = r.right, b = r.bottom, any = r.width > 0 || r.height > 0;
    el.querySelectorAll('*').forEach(function (c) {
      const cr = c.getBoundingClientRect();
      if (!cr.width && !cr.height) return;
      if (getComputedStyle(c).display === 'none') return;
      if (!any) { l = cr.left; t = cr.top; rt = cr.right; b = cr.bottom; any = true; return; }
      l = Math.min(l, cr.left); t = Math.min(t, cr.top); rt = Math.max(rt, cr.right); b = Math.max(b, cr.bottom);
    });
    return any ? { left: l, top: t, right: rt, bottom: b, width: rt - l, height: b - t } : null;
  }

  function reset(hand, deck) {
    deck.style.left = '';
    deck.classList.remove('deck-moved');
    hand.style.left = '';
    Array.prototype.forEach.call(hand.children, function (c) { c.style.marginLeft = ''; });
  }

  // Overlap the cards more so the row is at most `room` wide, but always keep a fifth of each card
  // visible (the corner with its rank and suit).
  function squeeze(cards, width, room) {
    const n = cards.length;
    const cw = cards[0].getBoundingClientRect().width;
    if (room <= cw || n < 2) return;
    const step = (width - cw) / (n - 1);
    const newStep = Math.max(cw * 0.2, (room - cw) / (n - 1));
    if (newStep >= step) return;
    const ml = -(cw - newStep);
    for (let i = 1; i < n; i++) cards[i].style.marginLeft = ml + 'px';
  }

  function fit(o) {
    const area = o.area, hand = o.hand, deck = o.deck;
    if (!area || !hand || !deck) return;
    reset(hand, deck);
    const cards = hand.children;
    if (cards.length < 2 || !area.offsetWidth) return;
    const A = area.getBoundingClientRect();
    const D = unionRect(deck);
    const H = hand.getBoundingClientRect();
    if (!D || !H.width) return;
    const gap = Math.max(6, A.width * 0.01);
    const overlapsY = D.bottom > H.top + 4 && D.top < H.bottom;
    const overlapsX = H.left < D.right + gap && H.right > D.left - gap;
    if (!overlapsY || !overlapsX) {
      // clear of the deck; only a hand wider than the table (a phone, 20+ cards) is squeezed to fit
      if (H.width > A.width - 2 * gap) squeeze(cards, H.width, A.width - 2 * gap);
      return;
    }

    // 1) the deck to the mirror spot on the right
    const leftInset = D.left - A.left;
    const targetLeft = A.right - leftInset - D.width;
    deck.style.left = (deck.offsetLeft + (targetLeft - D.left)) + 'px';
    deck.classList.add('deck-moved');

    // 2) the hand centred in the room left of the deck (the corner the deck left is free now)
    const roomLeft = A.left + gap;
    const roomRight = targetLeft - gap;
    const room = roomRight - roomLeft;
    // 3) still too wide: overlap more
    if (H.width > room) squeeze(cards, H.width, room);
    const W = hand.getBoundingClientRect().width;
    const centre = Math.max(roomLeft + W / 2, (roomLeft + roomRight) / 2);
    const parent = hand.offsetParent || area;
    hand.style.left = (centre - parent.getBoundingClientRect().left) + 'px';
  }

  window.UzsHandFit = { fit: fit, reset: reset };
})();
