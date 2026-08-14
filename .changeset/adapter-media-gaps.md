---
'@msgly/msteams': minor
'@msgly/line': patch
---

Fill in genuine media gaps in the Teams and LINE adapters.

Microsoft Teams now sends `video` and `audio` content — Bot Framework
attachments are content-type agnostic, so these take the same path as images
and files, and the capability flags were understating what the adapter could
do.

LINE now parses inbound `file` messages instead of silently dropping them.
Users can send files to a LINE bot even though the Messaging API has no file
message type to send back, so this is receive-only and `capabilities.media.file`
stays `false`. `downloadMedia` also preserves the filename and MIME type from
the reference.
