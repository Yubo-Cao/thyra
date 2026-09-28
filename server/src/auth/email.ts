import { randomInt, timingSafeEqual } from "node:crypto";

import { type AccountStore, hashSecret, randomToken } from "../accounts/store";
import type { EmailConfig } from "./providers";

/**
 * Email sign-in without passwords: one message carries a 6-digit code and a
 * one-time link, valid 10 minutes, used once, stored only as SHA-256
 * digests. The code exists for the iOS Home Screen app, whose mailed links
 * open in Safari (separate storage): the person types the code in the app.
 *
 * Every address gets the same answer whether or not it has an account, and
 * one message per address per minute (claimed in the database, so it holds
 * across restarts and the CLI).
 */

export const EMAIL_CODE_TTL_MS = 10 * 60_000;
export const EMAIL_COOLDOWN_MS = 60_000;
/** Wrong codes per mailed message before it stops working. */
export const EMAIL_CODE_ATTEMPTS = 5;
const EMAIL_PATTERN =
  /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/i;

/** A normalized address, or null when it cannot be one. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}

export type Mail = { to: string; subject: string; html: string; text: string };
export type Mailer = { send(mail: Mail): Promise<{ id: string | null }> };

/** Resend's REST API over `fetch`; no SDK. */
export function createResendMailer(
  config: EmailConfig,
  fetchImpl: typeof fetch = fetch,
): Mailer {
  return {
    async send(mail) {
      const response = await fetchImpl(config.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: config.from,
          to: [mail.to],
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        // The body may name the problem; never echo the key.
        const detail = (await response.text().catch(() => "")).slice(0, 200);
        throw new Error(
          `Resend refused the message (${response.status}) ${detail}`,
        );
      }
      const body = (await response.json().catch(() => ({}))) as {
        id?: unknown;
      };
      return { id: typeof body.id === "string" ? body.id : null };
    },
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const MINUTES = EMAIL_CODE_TTL_MS / 60_000;
const FOOTER_ZH = "如果不是你本人操作，请忽略这封邮件。";
const FOOTER_EN = "If you did not request this, ignore this email.";

function layout(zh: string, en: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#202124;background:#fff;line-height:1.6;font-size:15px">
<div style="max-width:480px">
<p style="margin:0 0 16px;font-weight:650">Thyra</p>
${zh}
<hr style="border:0;border-top:1px solid #ddd;margin:24px 0">
${en}
</div></body></html>`;
}

/** The sign-in message: code and link, Chinese first, then English. */
export function signInEmail(args: {
  code: string;
  link: string;
}): Omit<Mail, "to"> {
  const code = escapeHtml(args.code);
  const link = escapeHtml(args.link);
  const codeBlock = `<p style="margin:16px 0;font-size:28px;font-weight:700;letter-spacing:6px;font-family:ui-monospace,Menlo,monospace">${code}</p>`;
  return {
    subject: `Thyra 登录验证码 / sign-in code: ${args.code}`,
    html: layout(
      `<p style="margin:0">你的 Thyra 登录验证码：</p>${codeBlock}<p style="margin:0">也可以<a href="${link}">点击此链接登录</a>。${MINUTES} 分钟内有效，只能使用一次。</p><p style="margin:12px 0 0;color:#666;font-size:13px">${FOOTER_ZH}</p>`,
      `<p style="margin:0">Your Thyra sign-in code:</p>${codeBlock}<p style="margin:0">Or <a href="${link}">sign in with this link</a>. It expires in ${MINUTES} minutes and works once.</p><p style="margin:12px 0 0;color:#666;font-size:13px">${FOOTER_EN}</p>`,
    ),
    text: `你的 Thyra 登录验证码：${args.code}
也可以打开此链接登录：${args.link}
${MINUTES} 分钟内有效，只能使用一次。${FOOTER_ZH}

Your Thyra sign-in code: ${args.code}
Or sign in with this link: ${args.link}
It expires in ${MINUTES} minutes and works once. ${FOOTER_EN}
`,
  };
}

/** Confirming an address added on the account page: a code only. */
export function verifyEmail(args: { code: string }): Omit<Mail, "to"> {
  const code = escapeHtml(args.code);
  const codeBlock = `<p style="margin:16px 0;font-size:28px;font-weight:700;letter-spacing:6px;font-family:ui-monospace,Menlo,monospace">${code}</p>`;
  return {
    subject: `Thyra 邮箱验证码 / email code: ${args.code}`,
    html: layout(
      `<p style="margin:0">在 Thyra 账户页输入此验证码，将这个邮箱添加为登录方式：</p>${codeBlock}<p style="margin:0">${MINUTES} 分钟内有效。</p><p style="margin:12px 0 0;color:#666;font-size:13px">${FOOTER_ZH}</p>`,
      `<p style="margin:0">Enter this code on your Thyra account page to add this address as a sign-in method:</p>${codeBlock}<p style="margin:0">It expires in ${MINUTES} minutes.</p><p style="margin:12px 0 0;color:#666;font-size:13px">${FOOTER_EN}</p>`,
    ),
    text: `在 Thyra 账户页输入此验证码，将这个邮箱添加为登录方式：${args.code}
${MINUTES} 分钟内有效。${FOOTER_ZH}

Enter this code on your Thyra account page to add this address as a sign-in method: ${args.code}
It expires in ${MINUTES} minutes. ${FOOTER_EN}
`,
  };
}

/** An invitation: who invited, and the one-time link. */
export function inviteEmail(args: {
  inviter: string;
  link: string;
  days: number;
}): Omit<Mail, "to"> {
  const inviter = escapeHtml(args.inviter);
  const link = escapeHtml(args.link);
  return {
    subject: `${args.inviter} 邀请你使用 Thyra / invited you to Thyra`,
    html: layout(
      `<p style="margin:0">${inviter} 邀请你在 Thyra 中协作。</p><p style="margin:16px 0"><a href="${link}">接受邀请</a></p><p style="margin:0">链接 ${args.days} 天内有效，只能使用一次。之后可以用这个邮箱、Google、GitHub 或通行密钥登录。</p><p style="margin:12px 0 0;color:#666;font-size:13px">如果你不认识对方，请忽略这封邮件。</p>`,
      `<p style="margin:0">${inviter} invited you to work together in Thyra.</p><p style="margin:16px 0"><a href="${link}">Accept the invitation</a></p><p style="margin:0">The link works once within ${args.days} days. Afterwards you can sign in with this address, Google, GitHub or a passkey.</p><p style="margin:12px 0 0;color:#666;font-size:13px">If you do not know them, ignore this email.</p>`,
    ),
    text: `${args.inviter} 邀请你在 Thyra 中协作。
接受邀请：${args.link}
链接 ${args.days} 天内有效，只能使用一次。

${args.inviter} invited you to work together in Thyra.
Accept the invitation: ${args.link}
The link works once within ${args.days} days.
`,
  };
}

type CodeRow = {
  id: string;
  email: string;
  purpose: "login" | "verify";
  user_id: string | null;
  code_hash: string;
  link_hash: string;
  attempts: number;
  created_at: number;
  expires_at: number;
  used_at: number | null;
};

export type EmailCodeResult =
  | {
      ok: true;
      email: string;
      purpose: "login" | "verify";
      userId: string | null;
    }
  | { ok: false; reason: "invalid" | "expired" | "used" | "attempts" };

function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export type EmailCodeStore = ReturnType<typeof createEmailCodeStore>;

/** Mailed codes and links in the account database. */
export function createEmailCodeStore(store: AccountStore) {
  const { db } = store;
  return {
    /**
     * Claim a new code for an address, or null while the address is in its
     * one-minute cooldown (the caller answers exactly as if one was sent).
     */
    issue(args: {
      email: string;
      purpose: "login" | "verify";
      userId?: string | null;
    }): { id: string; code: string; linkSecret: string } | null {
      const at = store.now();
      return db.transaction(() => {
        const recent = db
          .query<{ id: string }, { email: string; since: number }>(
            "SELECT id FROM email_codes WHERE email = $email AND created_at > $since LIMIT 1",
          )
          .get({ email: args.email, since: at - EMAIL_COOLDOWN_MS });
        if (recent) return null;
        const id = randomToken(12);
        const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
        const linkSecret = randomToken(32);
        db.query(
          `INSERT INTO email_codes (id, email, purpose, user_id, code_hash, link_hash, created_at, expires_at)
           VALUES ($id, $email, $purpose, $user, $code, $link, $at, $expires)`,
        ).run({
          id,
          email: args.email,
          purpose: args.purpose,
          user: args.userId ?? null,
          code: hashSecret(`${id}:${code}`),
          link: hashSecret(linkSecret),
          at,
          expires: at + EMAIL_CODE_TTL_MS,
        });
        return { id, code, linkSecret };
      })();
    },

    /** Give a claimed cooldown back when delivery failed. */
    release(id: string) {
      db.query("DELETE FROM email_codes WHERE id = $id").run({ id });
    },

    /**
     * Check a typed code or a link secret for a flow. A right answer is
     * used up; wrong codes count toward the flow's attempt limit.
     */
    verify(args: {
      id: string;
      code?: string;
      link?: string;
    }): EmailCodeResult {
      if (typeof args.id !== "string" || args.id.length > 64)
        return { ok: false, reason: "invalid" };
      return db.transaction((): EmailCodeResult => {
        const row = db
          .query<CodeRow, { id: string }>(
            "SELECT * FROM email_codes WHERE id = $id",
          )
          .get({ id: args.id });
        if (!row) return { ok: false, reason: "invalid" };
        if (row.used_at) return { ok: false, reason: "used" };
        if (row.expires_at <= store.now())
          return { ok: false, reason: "expired" };
        if (row.attempts >= EMAIL_CODE_ATTEMPTS)
          return { ok: false, reason: "attempts" };
        const good =
          typeof args.link === "string" && args.link
            ? sameDigest(row.link_hash, hashSecret(args.link))
            : typeof args.code === "string" &&
              /^\d{6}$/.test(args.code.trim()) &&
              sameDigest(
                row.code_hash,
                hashSecret(`${row.id}:${args.code.trim()}`),
              );
        if (!good) {
          db.query(
            "UPDATE email_codes SET attempts = attempts + 1 WHERE id = $id",
          ).run({ id: row.id });
          return { ok: false, reason: "invalid" };
        }
        db.query("UPDATE email_codes SET used_at = $at WHERE id = $id").run({
          id: row.id,
          at: store.now(),
        });
        return {
          ok: true,
          email: row.email,
          purpose: row.purpose,
          userId: row.user_id,
        };
      })();
    },

    pruneExpired() {
      // Keep a row through its cooldown even when it expired early.
      db.query("DELETE FROM email_codes WHERE expires_at <= $now").run({
        now: store.now() - EMAIL_COOLDOWN_MS,
      });
    },
  };
}
