'use strict';

// server/feedback.js
//
// A very simple public feedback board: anyone (logged in or guest) can
// post feedback, a suggestion, or a bug report, and comment on existing
// posts. One specific account ("zivs") acts as the moderator: they can
// change a post's status (new / in progress / fixed), and edit or delete
// any post or comment that shouldn't stay public (spam, abuse, etc.).
//
// Persisted the same way as server/users.js — a JSON file under DATA_DIR,
// so it survives redeploys as long as DURAKS_DATA_DIR points at a mounted
// volume (see the comment in users.js for why that matters on Railway).
//
// Anti-spam is intentionally primitive (no CAPTCHA, no external service),
// per the brief — three cheap layers stacked together, each easy for a
// human to pass without noticing and each a little friction for a bot:
//   1. Honeypot field: the form has a hidden input a real browser never
//      fills in; any non-empty value there means it's a bot filling in
//      every field it can find.
//   2. Time trap: the client records when it first rendered the form and
//      sends that timestamp back; submitting faster than a human could
//      plausibly type is rejected. A bot that fires the socket event
//      immediately fails this.
//   3. IP-based rate limiting (reusing rate-limit.js, same as
//      login/register): caps how many posts/comments one IP can create
//      in a window, independent of the above.
// None of these stop a determined attacker, but together they filter out
// the overwhelming majority of generic spam bots with zero friction for
// real users.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRateLimiter } = require('./rate-limit');

const DATA_DIR = process.env.DURAKS_DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'feedback.json');

const MODERATOR_USERNAME = 'zivs'; // normalized (lowercase) — see isModerator()

const MIN_FORM_AGE_MS = 2000; // reject submissions faster than this
const MAX_FORM_AGE_MS = 6 * 60 * 60 * 1000; // reject stale/replayed timestamps
const MIN_TEXT_LEN = 3;
const MAX_POST_LEN = 2000;
const MAX_COMMENT_LEN = 1000;
const MAX_GUEST_NAME_LEN = 40;

const POST_TYPES = ['atsauksme', 'ieteikums', 'kluda'];
const STATUSES = ['jauns', 'labosana', 'izlabots'];

const postLimiter = createRateLimiter({ max: 5, windowMs: 10 * 60 * 1000, blockMs: 15 * 60 * 1000 });
const commentLimiter = createRateLimiter({ max: 10, windowMs: 10 * 60 * 1000, blockMs: 15 * 60 * 1000 });

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { posts: Array.isArray(parsed.posts) ? parsed.posts : [] };
  } catch {
    return { posts: [] };
  }
}

let store = load();

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
}

function isModerator(username) {
  return !!username && username.trim().toLowerCase() === MODERATOR_USERNAME;
}

function cleanText(text, maxLen) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length < MIN_TEXT_LEN || trimmed.length > maxLen) return null;
  return trimmed;
}

function cleanGuestName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim().replace(/\s+/g, ' ').slice(0, MAX_GUEST_NAME_LEN);
  return trimmed || null;
}

// Shared anti-spam gate for both new posts and comments. Returns an error
// string, or null if the submission passes.
function antiSpamCheck({ honeypot, formOpenedAt }, limiter, ip) {
  if (honeypot) return 'Spams noraidīts';
  const age = Date.now() - Number(formOpenedAt);
  if (!Number.isFinite(age) || age < MIN_FORM_AGE_MS) return 'Pārāk ātri — pamēģini vēlreiz';
  if (age > MAX_FORM_AGE_MS) return 'Veidlapa novecojusi — pārlādē lapu un mēģini vēlreiz';
  const rl = limiter.check(ip || 'unknown');
  if (!rl.allowed) return 'Pārāk daudz ierakstu — pamēģini vēlreiz pēc brīža';
  return null;
}

function authorLabel(username, guestName) {
  if (username) return { author: username, isGuest: false };
  return { author: cleanGuestName(guestName) || 'Anonīms', isGuest: true };
}

function toPublicPost(post) {
  return {
    id: post.id,
    type: post.type,
    text: post.text,
    author: post.author,
    isGuest: post.isGuest,
    status: post.status,
    createdAt: post.createdAt,
    editedAt: post.editedAt || null,
    comments: post.comments.map((c) => ({
      id: c.id,
      text: c.text,
      author: c.author,
      isGuest: c.isGuest,
      createdAt: c.createdAt,
      editedAt: c.editedAt || null,
    })),
  };
}

function listPosts() {
  return store.posts
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(toPublicPost);
}

function createPost({ type, text, guestName, username, honeypot, formOpenedAt, ip }) {
  const err = antiSpamCheck({ honeypot, formOpenedAt }, postLimiter, ip);
  if (err) return { error: err };
  const cleanedType = POST_TYPES.includes(type) ? type : null;
  if (!cleanedType) return { error: 'Nederīgs ieraksta veids' };
  const cleanedText = cleanText(text, MAX_POST_LEN);
  if (!cleanedText) return { error: `Teksts jābūt no ${MIN_TEXT_LEN} līdz ${MAX_POST_LEN} rakstzīmēm` };

  const { author, isGuest } = authorLabel(username, guestName);
  const post = {
    id: crypto.randomBytes(8).toString('hex'),
    type: cleanedType,
    text: cleanedText,
    author,
    isGuest,
    status: 'jauns',
    createdAt: Date.now(),
    editedAt: null,
    comments: [],
  };
  store.posts.push(post);
  save();
  return { ok: true, post: toPublicPost(post) };
}

function createComment({ postId, text, guestName, username, honeypot, formOpenedAt, ip }) {
  const err = antiSpamCheck({ honeypot, formOpenedAt }, commentLimiter, ip);
  if (err) return { error: err };
  const post = store.posts.find((p) => p.id === postId);
  if (!post) return { error: 'Ieraksts nav atrasts' };
  const cleanedText = cleanText(text, MAX_COMMENT_LEN);
  if (!cleanedText) return { error: `Komentāram jābūt no ${MIN_TEXT_LEN} līdz ${MAX_COMMENT_LEN} rakstzīmēm` };

  const { author, isGuest } = authorLabel(username, guestName);
  const comment = {
    id: crypto.randomBytes(8).toString('hex'),
    text: cleanedText,
    author,
    isGuest,
    createdAt: Date.now(),
    editedAt: null,
  };
  post.comments.push(comment);
  save();
  return { ok: true, postId, comment };
}

// --- moderator-only actions (all require isModerator(username) checked by the caller) ---

function setStatus(postId, status) {
  if (!STATUSES.includes(status)) return { error: 'Nederīgs statuss' };
  const post = store.posts.find((p) => p.id === postId);
  if (!post) return { error: 'Ieraksts nav atrasts' };
  post.status = status;
  save();
  return { ok: true };
}

function editPost(postId, text) {
  const cleanedText = cleanText(text, MAX_POST_LEN);
  if (!cleanedText) return { error: `Teksts jābūt no ${MIN_TEXT_LEN} līdz ${MAX_POST_LEN} rakstzīmēm` };
  const post = store.posts.find((p) => p.id === postId);
  if (!post) return { error: 'Ieraksts nav atrasts' };
  post.text = cleanedText;
  post.editedAt = Date.now();
  save();
  return { ok: true };
}

function deletePost(postId) {
  const idx = store.posts.findIndex((p) => p.id === postId);
  if (idx === -1) return { error: 'Ieraksts nav atrasts' };
  store.posts.splice(idx, 1);
  save();
  return { ok: true };
}

function editComment(postId, commentId, text) {
  const cleanedText = cleanText(text, MAX_COMMENT_LEN);
  if (!cleanedText) return { error: `Komentāram jābūt no ${MIN_TEXT_LEN} līdz ${MAX_COMMENT_LEN} rakstzīmēm` };
  const post = store.posts.find((p) => p.id === postId);
  if (!post) return { error: 'Ieraksts nav atrasts' };
  const comment = post.comments.find((c) => c.id === commentId);
  if (!comment) return { error: 'Komentārs nav atrasts' };
  comment.text = cleanedText;
  comment.editedAt = Date.now();
  save();
  return { ok: true };
}

function deleteComment(postId, commentId) {
  const post = store.posts.find((p) => p.id === postId);
  if (!post) return { error: 'Ieraksts nav atrasts' };
  const idx = post.comments.findIndex((c) => c.id === commentId);
  if (idx === -1) return { error: 'Komentārs nav atrasts' };
  post.comments.splice(idx, 1);
  save();
  return { ok: true };
}

// --- socket wiring ---

const BOARD_ROOM = 'feedback-board';

function registerFeedbackHandlers(io, socket, { getUsername }) {
  // Broadcast the shared post list to every viewer of the board — this
  // part is identical for everyone, so one emit to the room covers it.
  function broadcastPosts() {
    io.to(BOARD_ROOM).emit('feedbackData', { posts: listPosts() });
  }

  // isModerator depends on *this* socket's own login state, so it's never
  // part of the shared broadcast above — sent separately, only to this
  // socket, whenever it might have changed (join, or after any action).
  function sendYou() {
    socket.emit('feedbackYou', { isModerator: isModerator(getUsername()) });
  }

  socket.on('joinFeedback', () => {
    socket.join(BOARD_ROOM);
    socket.emit('feedbackData', { posts: listPosts() });
    sendYou();
  });

  socket.on('leaveFeedback', () => {
    socket.leave(BOARD_ROOM);
  });

  socket.on('getFeedback', () => {
    socket.emit('feedbackData', { posts: listPosts() });
    sendYou();
  });

  socket.on('submitFeedback', ({ type, text, guestName, honeypot, formOpenedAt } = {}) => {
    const username = getUsername();
    const result = createPost({
      type,
      text,
      guestName,
      username,
      honeypot,
      formOpenedAt,
      ip: socket.handshake.address || socket.id,
    });
    if (result.error) return socket.emit('feedbackError', result.error);
    broadcastPosts();
  });

  socket.on('submitFeedbackComment', ({ postId, text, guestName, honeypot, formOpenedAt } = {}) => {
    const username = getUsername();
    const result = createComment({
      postId,
      text,
      guestName,
      username,
      honeypot,
      formOpenedAt,
      ip: socket.handshake.address || socket.id,
    });
    if (result.error) return socket.emit('feedbackError', result.error);
    broadcastPosts();
  });

  function requireModerator(cb) {
    if (!isModerator(getUsername())) {
      socket.emit('feedbackError', 'Tikai moderators var veikt šo darbību');
      return;
    }
    cb();
  }

  socket.on('setFeedbackStatus', ({ postId, status } = {}) => {
    requireModerator(() => {
      const result = setStatus(postId, status);
      if (result.error) return socket.emit('feedbackError', result.error);
      broadcastPosts();
    });
  });

  socket.on('editFeedbackPost', ({ postId, text } = {}) => {
    requireModerator(() => {
      const result = editPost(postId, text);
      if (result.error) return socket.emit('feedbackError', result.error);
      broadcastPosts();
    });
  });

  socket.on('deleteFeedbackPost', ({ postId } = {}) => {
    requireModerator(() => {
      const result = deletePost(postId);
      if (result.error) return socket.emit('feedbackError', result.error);
      broadcastPosts();
    });
  });

  socket.on('editFeedbackComment', ({ postId, commentId, text } = {}) => {
    requireModerator(() => {
      const result = editComment(postId, commentId, text);
      if (result.error) return socket.emit('feedbackError', result.error);
      broadcastPosts();
    });
  });

  socket.on('deleteFeedbackComment', ({ postId, commentId } = {}) => {
    requireModerator(() => {
      const result = deleteComment(postId, commentId);
      if (result.error) return socket.emit('feedbackError', result.error);
      broadcastPosts();
    });
  });
}

module.exports = { registerFeedbackHandlers, POST_TYPES, STATUSES };
