'use strict';

// public/board-client.js — standalone page, doesn't load client.js, so it
// defines its own tiny helpers instead of sharing state with the main game.

const el = (id) => document.getElementById(id);

// Same localStorage keys client.js uses for "remember me", so someone
// already logged into the game is automatically recognized here too —
// their posts/comments get attributed to their account instead of asking
// them to type a guest name.
const USER_KEY = 'duraks_username';
const TOKEN_KEY = 'duraks_token';

const socket = io();

let myUsername = null;
let isModerator = false;
let selectedType = 'atsauksme';
const pageLoadedAt = Date.now(); // anti-spam time-trap, see server/feedback.js

const TYPE_LABELS = { atsauksme: '💬 Atsauksme', ieteikums: '💡 Ieteikums', kluda: '🐞 Kļūda' };
const STATUS_LABELS = { jauns: 'Jauns', labosana: 'Labošanā', izlabots: 'Izlabots' };

function showToast(msg) {
  const t = el('boardToast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.add('hidden'), 2800);
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString('lv-LV', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// --- auth (silent) ---

const savedUser = localStorage.getItem(USER_KEY);
const savedToken = localStorage.getItem(TOKEN_KEY);
if (savedUser && savedToken) {
  socket.emit('loginWithToken', { username: savedUser, token: savedToken });
} else {
  socket.emit('joinFeedback');
}

socket.on('registered', (rec) => {
  myUsername = rec.username;
  el('guestNameField').classList.add('hidden');
  socket.emit('joinFeedback');
});

socket.on('errorMsg', () => {
  // loginWithToken failed (stale/invalid token) — carry on as a guest,
  // same as the main page would.
  socket.emit('joinFeedback');
});

socket.on('feedbackYou', (data) => {
  isModerator = !!data.isModerator;
  render(lastPosts);
});

// --- post type picker ---

function setSelectedType(type) {
  selectedType = type;
  document.querySelectorAll('#newPostTypeGroup .btn-option').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === type);
  });
}
el('newPostTypeGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-option');
  if (!btn) return;
  setSelectedType(btn.dataset.value);
});
setSelectedType('atsauksme');

// --- submit new post ---

el('newPostSubmitBtn').addEventListener('click', () => {
  const text = el('newPostText').value.trim();
  const statusEl = el('newPostStatus');
  statusEl.classList.add('hidden');
  if (!text) {
    statusEl.textContent = 'Ievadi tekstu';
    statusEl.classList.remove('hidden');
    return;
  }
  socket.emit('submitFeedback', {
    type: selectedType,
    text,
    guestName: el('newPostGuestName').value,
    honeypot: el('newPostHoneypot').value,
    formOpenedAt: pageLoadedAt,
  });
});

socket.on('feedbackError', (msg) => {
  const statusEl = el('newPostStatus');
  statusEl.textContent = msg;
  statusEl.classList.remove('hidden');
  showToast(msg);
});

// --- rendering ---

let lastPosts = [];
const expandedComments = new Set(); // postIds whose comment box is open — restored across re-renders

socket.on('feedbackData', (data) => {
  lastPosts = data.posts || [];
  render(lastPosts);
});

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function authorLine(post) {
  if (post.isGuest) return `${escapeHtml(post.author)} (viesis)`;
  return escapeHtml(post.author);
}

function moderationControlsHtml(post) {
  if (!isModerator) return '';
  const statusButtons = Object.keys(STATUS_LABELS)
    .map(
      (s) =>
        `<button class="btn btn-secondary board-set-status" data-post="${post.id}" data-status="${s}" ${
          post.status === s ? 'disabled' : ''
        }>${STATUS_LABELS[s]}</button>`
    )
    .join('');
  return `
    <div class="board-mod-controls">
      ${statusButtons}
      <button class="btn btn-secondary board-edit-post" data-post="${post.id}">✏️ Rediģēt</button>
      <button class="btn btn-danger board-delete-post" data-post="${post.id}">🗑️ Dzēst</button>
    </div>
  `;
}

function commentHtml(post, comment) {
  const modControls = isModerator
    ? `<button class="board-comment-toggle board-edit-comment" data-post="${post.id}" data-comment="${comment.id}">✏️</button>
       <button class="board-comment-toggle board-delete-comment" data-post="${post.id}" data-comment="${comment.id}">🗑️</button>`
    : '';
  return `
    <div class="board-comment">
      <div class="board-comment-head">
        <span class="board-comment-author">${escapeHtml(comment.author)}${comment.isGuest ? ' (viesis)' : ''}</span>
        <span class="board-comment-time">${fmtTime(comment.createdAt)}${comment.editedAt ? ' · rediģēts' : ''}</span>
        ${modControls}
      </div>
      <p class="board-comment-text">${escapeHtml(comment.text)}</p>
    </div>
  `;
}

function postHtml(post) {
  const commentsCount = post.comments.length;
  const commentsHtml = post.comments.map((c) => commentHtml(post, c)).join('');
  return `
    <article class="board-post" data-post="${post.id}">
      <div class="board-post-head">
        <span class="board-type-badge type-${post.type}">${TYPE_LABELS[post.type] || post.type}</span>
        <span class="board-status-badge status-${post.status}">${STATUS_LABELS[post.status] || post.status}</span>
        <span class="board-post-author">${authorLine(post)} · ${fmtTime(post.createdAt)}${post.editedAt ? ' · rediģēts' : ''}</span>
      </div>
      <p class="board-post-text">${escapeHtml(post.text)}</p>
      ${moderationControlsHtml(post)}
      <button class="board-comment-toggle board-toggle-comments" data-post="${post.id}">
        💬 ${commentsCount ? `${commentsCount} komentāri` : 'Pievienot komentāru'}
      </button>
      <div class="board-comments${expandedComments.has(post.id) ? '' : ' hidden'}" data-comments-for="${post.id}">
        ${commentsHtml}
        <div class="board-comment-form">
          <input type="text" class="board-comment-guest-name" placeholder="${
            myUsername ? '' : 'Tavs vārds (nav obligāts)'
          }" ${myUsername ? 'style="display:none"' : ''} maxlength="40" />
          <input type="text" class="board-comment-text-input" placeholder="Raksti komentāru..." maxlength="1000" />
          <input type="text" class="board-honeypot-inline" style="position:absolute;left:-9999px;width:1px;height:1px;" tabindex="-1" autocomplete="off" />
          <button class="btn btn-primary board-comment-submit" data-post="${post.id}">Sūtīt</button>
        </div>
      </div>
    </article>
  `;
}

function render(posts) {
  const listEl = el('boardList');
  const emptyEl = el('boardEmpty');
  if (!posts.length) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');
  listEl.innerHTML = posts.map(postHtml).join('');
}

// --- event delegation for dynamically-rendered content ---

el('boardList').addEventListener('click', (e) => {
  const toggleBtn = e.target.closest('.board-toggle-comments');
  if (toggleBtn) {
    const postId = toggleBtn.dataset.post;
    const box = document.querySelector(`[data-comments-for="${postId}"]`);
    box.classList.toggle('hidden');
    if (box.classList.contains('hidden')) expandedComments.delete(postId);
    else expandedComments.add(postId);
    return;
  }

  const setStatusBtn = e.target.closest('.board-set-status');
  if (setStatusBtn) {
    socket.emit('setFeedbackStatus', { postId: setStatusBtn.dataset.post, status: setStatusBtn.dataset.status });
    return;
  }

  const editPostBtn = e.target.closest('.board-edit-post');
  if (editPostBtn) {
    const post = lastPosts.find((p) => p.id === editPostBtn.dataset.post);
    const next = prompt('Rediģēt tekstu:', post ? post.text : '');
    if (next !== null && next.trim()) {
      socket.emit('editFeedbackPost', { postId: editPostBtn.dataset.post, text: next.trim() });
    }
    return;
  }

  const deletePostBtn = e.target.closest('.board-delete-post');
  if (deletePostBtn) {
    if (confirm('Dzēst šo ierakstu un visus tā komentārus?')) {
      socket.emit('deleteFeedbackPost', { postId: deletePostBtn.dataset.post });
    }
    return;
  }

  const editCommentBtn = e.target.closest('.board-edit-comment');
  if (editCommentBtn) {
    const post = lastPosts.find((p) => p.id === editCommentBtn.dataset.post);
    const comment = post && post.comments.find((c) => c.id === editCommentBtn.dataset.comment);
    const next = prompt('Rediģēt komentāru:', comment ? comment.text : '');
    if (next !== null && next.trim()) {
      socket.emit('editFeedbackComment', {
        postId: editCommentBtn.dataset.post,
        commentId: editCommentBtn.dataset.comment,
        text: next.trim(),
      });
    }
    return;
  }

  const deleteCommentBtn = e.target.closest('.board-delete-comment');
  if (deleteCommentBtn) {
    if (confirm('Dzēst šo komentāru?')) {
      socket.emit('deleteFeedbackComment', {
        postId: deleteCommentBtn.dataset.post,
        commentId: deleteCommentBtn.dataset.comment,
      });
    }
    return;
  }

  const submitCommentBtn = e.target.closest('.board-comment-submit');
  if (submitCommentBtn) {
    const postId = submitCommentBtn.dataset.post;
    const box = document.querySelector(`[data-comments-for="${postId}"]`);
    const textInput = box.querySelector('.board-comment-text-input');
    const guestInput = box.querySelector('.board-comment-guest-name');
    const honeypotInput = box.querySelector('.board-honeypot-inline');
    const text = textInput.value.trim();
    if (!text) return;
    socket.emit('submitFeedbackComment', {
      postId,
      text,
      guestName: guestInput.value,
      honeypot: honeypotInput.value,
      formOpenedAt: pageLoadedAt,
    });
    textInput.value = '';
  }
});
