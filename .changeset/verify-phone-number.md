---
'@msgly/twilio-sms': minor
'@msgly/twilio-voice': minor
'@msgly/genesys-sms': minor
'@msgly/genesys-voice': minor
'@msgly/dial': minor
'@msgly/core': minor
---

Verify the configured phone number at setup time, not at first send.

Until now these five adapters checked their number was non-empty and nothing
more. A number with the country code missing, or one belonging to a different
account entirely, sailed through `verifyCredentials()` and only surfaced later
as an opaque provider error on a real send — far from the screen where it was
typed.

Each adapter now exposes **`verifyPhoneNumber()`**, and `verifyCredentials()`
calls it, so the normal setup flow gets the check for free and reports which
field is actually wrong: the key, the secret, or the number. It is exposed
separately for the case where the number is changed on an already-connected
account, and for showing the number's status apart from the credential status.

The check has two stages. First a local E.164 format gate — `isValidE164` and
`describeE164Problem`, new in `@msgly/core`, which name the specific mistake
("missing the leading +", "strip spaces, dashes") rather than saying invalid.
Then a provider lookup that answers the question a format check cannot: is
this number actually on this account?

- **Twilio** — `GET /2010-04-01/Accounts/{SID}/IncomingPhoneNumbers.json`
- **Genesys SMS** — `GET /api/v2/routing/sms/phonenumbers`
- **Genesys Voice** — `GET /api/v2/telephony/providers/edges/dids`
- **Dial** — no extra request: `verifyCredentials` already fetched
  `/api/v1/phone-numbers` and discarded the body. Dial's `fromNumber` may be an
  id, an E.164 number, or a nickname, so it matches on any of them and skips
  the E.164 gate, which would reject two of the three valid forms.

**An unanswerable lookup is not a failure.** `PhoneNumberCheckResult.status`
has four values, not two: `owned`, `not_owned`, `malformed`, and
`inconclusive`. A Genesys OAuth client without `routing:smsPhoneNumber:view`,
or a restricted Twilio key that cannot list numbers, cannot answer the
ownership question — reporting that as `not_owned` would make working
credentials look broken over a missing read permission. Those cases return
`ok: true` with `status: 'inconclusive'` and a hint explaining why, so only a
definite `not_owned` or `malformed` fails the check.

**The provider endpoints are modeled, not fetched.** Twilio's
`IncomingPhoneNumbers` resource is well documented; the Genesys inventory/DID
paths and Dial's number-list envelope are written from platform knowledge, the
same caveat the Genesys adapters already carry throughout. This is why an
unanswerable lookup fails open: if a path or envelope is wrong, the check
reports `inconclusive` and setup still succeeds, rather than rejecting a valid
number. Dial's matcher accepts a bare array plus the plausible wrappers
(`phoneNumbers`, `phone_numbers`, `data`, `numbers`, `entities`) for the same
reason.

Note that `verifyCredentials()` on these five adapters now fails when the
number is wrong, where before it only checked the key. `@msgly/dial`'s existing
"healthy key" test fixture had to gain a number for this reason — an empty
number list now legitimately means "that number is not on this account".

`@msgly/dial` additionally exports `matchDialFromNumber(body, fromNumber)`,
the pure matcher behind its check, for callers that already hold a number list.

Existing `verifyCredentials()` callers need no change: the return type is
unchanged, and `accountInfo` keeps its current format on success.
