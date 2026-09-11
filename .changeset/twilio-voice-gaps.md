---
'@msgly/twilio-voice': minor
---

Fix the Twilio Voice response model, which could not work as designed, and close
the gaps between what the adapter claimed and what it did.

**Callers heard each other's TwiML.** The adapter buffered the reply in a single
`pendingTwiml` variable shared by every call. The hub calls `getInteractionAck`
*before* `handleWebhook` and responds immediately, so the value was always one
request stale: the first caller got the literal string `ok` as their TwiML
document (invalid, so the call dropped), and every caller after that heard the
response meant for the previous one — including a different person's. There was
no test for `send()` or `getInteractionAck`, which is how it survived.

A phone call is request/response: Twilio holds the HTTP request open and speaks
whatever comes back, so the reply has to be produced *during* that request.
There is now a `respond(message)` config hook that does exactly that, per
request, with no shared state. It is deliberately synchronous — Twilio abandons
a webhook after ~15s and an `await` there is dead air on the line.

`send()` no longer buffers anything. It drives a call that is already in
progress through Twilio's REST API (`POST /Calls/{Sid}`), keyed on
`metadata.callSid` from the inbound message, which is the only way Twilio lets
you change a live call. Without a CallSid it fails with a message pointing at
`respond` instead.

**`capabilities.media.audio` was `true` while `send()` rejected everything but
text.** Because the flag said yes, the hub passed audio through and the adapter
then failed it at runtime, instead of the hub refusing it cleanly. Audio now
maps to `<Play>`, and a non-URL `mediaRef` is rejected with the reason (Twilio
fetches the file itself, so an uploaded media id means nothing to it).

**The README documented an interactive `<Gather>` mapping that did not exist**
— `interactive.buttons` was `false` and `send()` refused the content type.
Implemented: buttons map to DTMF digits by position, and the keypress comes back
as an inbound text message containing the digit.

**Unverifiable webhooks are now rejected.** `verifySignature` previously
returned `true` when `webhookUrl` was unset. The signature covers the full URL,
so without one there is nothing to verify — and accepting anyway let anyone who
found the endpoint fake calls and drive the IVR. Set
`allowUnsignedWebhooks: true` where something else authenticates the request.
This is the one behaviour change that can affect an existing deployment: if you
run without `webhookUrl`, you were never verifying anything, and now you must
say so explicitly.

Also added: `parseStatuses()` turning call progress into delivery receipts
(ringing → sent, answered → delivered, completed → read, with busy and no-answer
marked transient and only a failed call permanent, so a busy signal never
suppresses a number); `updateCall()` and `endCall()`; and `downloadMedia()`,
which now fetches `<Record>` recordings — they sit behind account credentials
and Twilio only serves them with a file extension, so both are handled.

Tests went from 16 to 40, covering the request/response path, the REST send,
status mapping and call control — none of which had any coverage before.
