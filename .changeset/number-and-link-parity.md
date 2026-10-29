---
'@msgly/core': minor
'@msgly/plivo': minor
'@msgly/vonage-sms': minor
'@msgly/telnyx': minor
'@msgly/plivo-voice': minor
'@msgly/vonage-voice': minor
'@msgly/exotel-voice': minor
'@msgly/dial': minor
---

Close the parity gaps left by 1.10 and 1.11: setup-time number checks on the
rest of the phone channels, and a chat link for Dial.

**`verifyPhoneNumber()` on six more adapters.** 1.10 added it to Twilio SMS,
Twilio Voice, Genesys SMS, Genesys Voice and Dial, which left every other
number-carrying channel checking only that its sender field was non-empty. All
six now behave the same way: a local E.164 gate that names the specific mistake
("missing the leading +", "strip spaces, dashes"), then a provider lookup
answering the question a format check cannot — is this number actually on this
account? `verifyCredentials()` calls it, so the normal setup flow gets the check
for free and reports which field is wrong.

- **Plivo** — `GET /v1/Account/{auth_id}/Number/`
- **Plivo Voice** — the same resource
- **Vonage SMS** — `GET /account/numbers`
- **Telnyx** — `GET /v2/phone_numbers?filter[phone_number]=…`
- **Exotel Voice** — `GET /v1/Accounts/{sid}/IncomingPhoneNumbers.json`
- **Vonage Voice** — format only, see below

Plivo and Vonage return their numbers without a leading `+`, so the comparison
is on digits. `@msgly/core` gains **`phoneDigits`**, **`sameNumber`** and
**`isAlphanumericSenderId`** for this, next to the existing `isValidE164` and
`describeE164Problem`.

**An alphanumeric sender ID is `inconclusive`, not `malformed`.** Plivo, Vonage
and Telnyx all accept either a number or a registered sender id in the same
field. A sender id is registered with the destination carrier rather than rented
on the account, so there is nothing to look it up against — and running the
E.164 gate on one would reject a working configuration. It reports `ok: true`
with a hint noting that recipients cannot reply and that several countries
reject it outright.

**Vonage Voice is a format check only, deliberately.** Vonage rents numbers at
the account level and the only endpoint that lists them authenticates with the
`api_key`/`api_secret` pair `@msgly/vonage-sms` takes; a Voice application JWT
cannot read it, and `VonageVoiceConfig` has no reason to carry account
credentials just for a setup check. A well-formed number reports `inconclusive`
rather than `owned` — the mistakes people actually hit are caught, and the
ownership question is reported as unanswered rather than guessed at. Vonage
Voice also takes its number without a leading `+`, unlike every other adapter
here; the gate accepts either form and names the one Vonage wants.

**Unanswerable lookups still fail open**, as in 1.10: a key without permission
to list numbers, or an unexpected response, reports `ok: true` with
`inconclusive`. Only a definite `not_owned` or `malformed` fails. Exotel Voice's
endpoint is **modeled, not fetched** — Exotel's v1 API is shaped like Twilio's,
and several envelopes are accepted — which is exactly why it fails open.

Note that `verifyCredentials()` on these six adapters now fails when the sender
is wrong, where before it only checked the credentials. Two existing test
fixtures had to gain a number for this reason: an empty number list now
legitimately means "that number is not on this account".

**`@msgly/dial` gains `getChatLink()`.** 1.11 shipped chat links for every
channel that has one and listed the omissions, but Dial fell through: it was
grouped with neither the SMS rails that got `sms:` links nor the senders that
cannot receive a reply. A Dial line is a real provisioned number, so it gets the
same `sms:<number>` link, with `text` prefilled and `tracked: false`. One link
covers the line however it is provisioned — the system messaging app picks
between SMS/MMS and iMessage itself. It returns `null` when `fromNumber` is a
phone-number id or a nickname, since neither is something a scanner can dial.
