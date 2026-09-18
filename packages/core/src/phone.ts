/**
 * E.164 phone-number validation.
 *
 * Adapters that carry a phone number (Twilio, Genesys, Dial) check the number
 * they were configured with at `verifyCredentials` time, so a typo surfaces
 * when someone enters their credentials rather than as an opaque provider
 * error on the first send.
 *
 * This is a format gate only — it says the string is shaped like a phone
 * number, not that the number exists or belongs to the account. Adapters pair
 * it with a provider lookup for that.
 */

/**
 * E.164: a leading `+`, a country code starting 1-9, then up to 14 more
 * digits — 15 digits total at most. No spaces, dashes, or parentheses.
 */
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

/** True when `value` is a well-formed E.164 number. */
export function isValidE164(value: string | undefined | null): boolean {
  if (typeof value !== 'string') return false;
  return E164_PATTERN.test(value);
}

/**
 * Explain why `value` isn't E.164, phrased for a setup hint, or `null` when
 * it is valid. The specific cases are the ones people actually hit: a number
 * typed in local format, or pasted with the separators still in it.
 */
export function describeE164Problem(
  value: string | undefined | null,
): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return 'is missing';
  }
  if (isValidE164(value)) return null;

  const trimmed = value.trim();

  // Checked before anything else: the value is right, only the padding is
  // wrong, and every branch below would otherwise misdiagnose it.
  if (isValidE164(trimmed)) {
    return `"${value}" has leading or trailing whitespace — use "${trimmed}"`;
  }
  if (!trimmed.startsWith('+')) {
    const digits = trimmed.replace(/\D/g, '');
    return `"${value}" is missing the leading "+" and country code — E.164 looks like +15551234567${
      digits ? ` (perhaps +${digits}?)` : ''
    }`;
  }
  if (trimmed.indexOf('+', 1) !== -1) {
    return `"${value}" has more than one "+" — E.164 takes exactly one, at the front, e.g. +15551234567`;
  }
  if (/[^\d+]/.test(trimmed)) {
    return `"${value}" contains characters that E.164 doesn't allow — strip spaces, dashes and parentheses, e.g. +15551234567`;
  }
  if (trimmed.startsWith('+0')) {
    return `"${value}" starts with a country code of 0, which E.164 doesn't allow — use the international country code, e.g. +15551234567`;
  }

  // Everything after the "+" is now known to be a digit, so this is a true
  // digit count rather than a character count.
  const digitCount = trimmed.length - 1;
  if (digitCount < 7) {
    return `"${value}" is too short for E.164 (${digitCount} digits) — include the country code, e.g. +15551234567`;
  }
  if (digitCount > 15) {
    return `"${value}" is too long for E.164 (${digitCount} digits, max 15) — e.g. +15551234567`;
  }
  // Unreachable for current rules, but a wrong explanation is worse than a
  // vague one if the pattern and these branches ever drift apart.
  return `"${value}" is not a valid E.164 number — e.g. +15551234567`;
}

/**
 * The outcome of an adapter's `verifyPhoneNumber()`.
 *
 * Separate from `CredentialsCheckResult` because the question is narrower —
 * "is this number usable on this account?" — and because it has a third
 * answer beyond yes/no: the provider lookup may be unavailable, which is
 * inconclusive rather than a failure.
 */
export interface PhoneNumberCheckResult {
  /**
   * False only when the number is definitely unusable. An inconclusive check
   * reports `ok: true` with `status: 'inconclusive'`, so a missing API
   * permission never makes a working number look broken.
   */
  ok: boolean;
  /**
   * - `owned` — the provider confirms this number is on the account.
   * - `not_owned` — the provider says it isn't. Sends will fail.
   * - `malformed` — the value isn't a valid E.164 number; no lookup was made.
   * - `inconclusive` — well-formed, but ownership couldn't be confirmed
   *   (lookup failed, or the credentials can't list numbers).
   */
  status: 'owned' | 'not_owned' | 'malformed' | 'inconclusive';
  /** The number that was checked, as configured. */
  phoneNumber: string;
  /** Actionable explanation. Always set unless `status` is `owned`. */
  hint?: string;
}
