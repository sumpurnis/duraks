'use strict';

// Thin wrapper around nodemailer for the two transactional emails this app
// sends: a password-reset link and a username reminder. Configured purely
// through environment variables so no credentials ever live in code or in
// chat — set these on the host (e.g. Railway's Variables tab):
//
//   SMTP_HOST   e.g. smtp.gmail.com
//   SMTP_PORT   e.g. 465 (SSL) or 587 (STARTTLS) — defaults to 587
//   SMTP_USER   the sending account's address
//   SMTP_PASS   an app password (NOT the account's normal login password —
//               Gmail and most providers require a separate 16-character
//               "app password" for SMTP, generated in the account's
//               security settings)
//   MAIL_FROM   optional; defaults to SMTP_USER
//
// If these aren't set (e.g. in local dev, or this sandbox), emails aren't
// actually sent — the content is logged to the console instead, so the
// reset-link/username-reminder flow can still be developed and tested
// end-to-end without a real mailbox.

const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;

const configured = !!(SMTP_HOST && SMTP_USER && SMTP_PASS);

let transporter = null;
if (configured) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

async function send(to, subject, text, html) {
  if (!configured) {
    console.log(
      `\n[mailer] SMTP nav konfigurēts (trūkst SMTP_HOST/SMTP_USER/SMTP_PASS) — e-pasts NAV nosūtīts.\n` +
        `Būtu nosūtīts uz: ${to}\nTēma: ${subject}\n${text}\n`
    );
    return;
  }
  await transporter.sendMail({ from: MAIL_FROM, to, subject, text, html });
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
