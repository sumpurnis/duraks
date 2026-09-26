'use strict';

// Thin wrapper around the Resend HTTPS email API for the two transactional
// emails this app sends: a password-reset link and a username reminder.
//
// Why Resend's HTTPS API instead of raw SMTP: many cloud hosts (Railway
// included) block outbound SMTP ports (25/465/587) entirely to prevent
// spam abuse, so nodemailer-over-SMTP just times out there no matter how
// it's configured. An HTTPS API call on port 443 isn't affected by that,
// and Resend's free tier (3,000 emails/month) is enough for this app.
// Uses Node's built-in fetch, so no extra dependency is needed.
//
// Configured purely through environment variables so no credentials ever
// live in code or in chat — set these on the host (e.g. Railway's
// Variables tab):
//
//   RESEND_API_KEY   from https://resend.com/api-keys
//   MAIL_FROM        the verified sending address, e.g.
//                     "Duraks <info@yourdomain.com>", or Resend's shared
//                     "onboarding@resend.dev" sender while testing before
//                     you've verified your own domain
//
// If these aren't set (e.g. in local dev, or this sandbox), emails aren't
// actually sent — the content is logged to the console instead, so the
// reset-link/username-reminder flow can still be developed and tested
// end-to-end without a real mailbox.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || 'onboarding@resend.dev';

const configured = !!RESEND_API_KEY;

async function send(to, subject, text, html) {
  if (!configured) {
    console.log(
      `\n[mailer] RESEND_API_KEY nav konfigurēts — e-pasts NAV nosūtīts.\n` +
        `Būtu nosūtīts uz: ${to}\nTēma: ${subject}\n${text}\n`
    );
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: MAIL_FROM, to, subject, text, html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

function sendPasswordResetEmail(to, username, link) {
  const subject = 'Paroles atiestatīšana — Duraks';
  const text =
    `Sveiks, ${username}!\n\n` +
    `Saņēmām pieprasījumu atiestatīt tavu paroli. Nospied šo saiti, lai izvēlētos jaunu paroli ` +
    `(saite derīga 1 stundu):\n${link}\n\n` +
    `Ja tu to nepieprasīji, vari šo e-pastu vienkārši ignorēt — tava parole netiks mainīta.`;
  const html =
    `<p>Sveiks, <strong>${username}</strong>!</p>` +
    `<p>Saņēmām pieprasījumu atiestatīt tavu paroli. Nospied šo saiti, lai izvēlētos jaunu paroli ` +
    `(saite derīga 1 stundu):</p>` +
    `<p><a href="${link}">${link}</a></p>` +
    `<p>Ja tu to nepieprasīji, vari šo e-pastu vienkārši ignorēt — tava parole netiks mainīta.</p>`;
  return send(to, subject, text, html);
}

function sendUsernameReminderEmail(to, username) {
  const subject = 'Tavs lietotājvārds — Duraks';
  const text = `Sveiks!\n\nTavs lietotājvārds ir: ${username}\n\nJa tu to nepieprasīji, vari šo e-pastu ignorēt.`;
  const html =
    `<p>Sveiks!</p><p>Tavs lietotājvārds ir: <strong>${username}</strong></p>` +
    `<p>Ja tu to nepieprasīji, vari šo e-pastu ignorēt.</p>`;
  return send(to, subject, text, html);
}

module.exports = {
  sendPasswordResetEmail,
  sendUsernameReminderEmail,
  isConfigured: () => configured,
};
