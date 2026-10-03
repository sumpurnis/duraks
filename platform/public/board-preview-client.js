'use strict';

// public/board-preview-client.js — read-only preview of the feedback board
// (server/feedback.js) shown as the third lobby column on the main page.
// Reuses the `socket` global that client.js already created (same pattern
// multi-client.js and tournament-client.js follow), so this doesn't open a
// second connection.

const BOARD_PREVIEW_TYPE_LABELS = { atsauksme: '💬 Atsauksme', ieteikums: '💡 Ieteikums', kluda: '🐞 Kļūda' };
const BOARD_PREVIEW_STATUS_LABELS = { jauns: 'Jauns', labosana: 'Labošanā', izlabots: 'Izlabots' };
const BOARD_PREVIEW_LIMIT = 8; // most recent N posts — the scrollable box handles the rest

function boardPreviewEscapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function renderBoardPreview(posts) {
  const listEl = document.getElementById('boardPreviewList');
  if (!listEl) return; // this script is also fine to include on pages without the panel
  if (!posts.length) {
    listEl.innerHTML = '<p class="board-preview-empty">Vēl nav neviena ieraksta — esi pirmais!</p>';
    return;
  }
  listEl.innerHTML = posts
    .slice(0, BOARD_PREVIEW_LIMIT)
    .map((post) => {
      const author = post.isGuest ? `${boardPreviewEscapeHtml(post.author)} (viesis)` : boardPreviewEscapeHtml(post.author);
      return `
        <a class="board-preview-item" href="/board.html">
          <div class="board-preview-item-head">
            <span class="board-type-badge type-${post.type}">${BOARD_PREVIEW_TYPE_LABELS[post.type] || post.type}</span>
            <span class="board-status-badge status-${post.status}">${BOARD_PREVIEW_STATUS_LABELS[post.status] || post.status}</span>
            <span class="board-preview-item-author">${author}</span>
          </div>
          <p class="board-preview-item-text">${boardPreviewEscapeHtml(post.text)}</p>
        </a>
      `;
    })
    .join('');
}

socket.on('feedbackData', (data) => {
  renderBoardPreview(data.posts || []);
});

// Ask for the current board state once connected — 'joinFeedback' both
// requests it and subscribes this socket to live updates (a new post
// appearing on the board while someone sits on the lobby page updates
// this preview immediately too, same as the leaderboard panel next to it).
if (socket.connected) {
  socket.emit('joinFeedback');
} else {
  socket.on('connect', () => socket.emit('joinFeedback'));
}
