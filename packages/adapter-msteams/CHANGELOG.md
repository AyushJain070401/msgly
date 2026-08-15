# @msgly/msteams

## 1.1.0

### Minor Changes

- 20e7146: Fill in genuine media gaps in the Teams and LINE adapters.

  Microsoft Teams now sends `video` and `audio` content — Bot Framework
  attachments are content-type agnostic, so these take the same path as images
  and files, and the capability flags were understating what the adapter could
  do.

  LINE now parses inbound `file` messages instead of silently dropping them.
  Users can send files to a LINE bot even though the Messaging API has no file
  message type to send back, so this is receive-only and `capabilities.media.file`
  stays `false`. `downloadMedia` also preserves the filename and MIME type from
  the reference.

### Patch Changes

- Updated dependencies [20e7146]
- Updated dependencies [8f5aa23]
- Updated dependencies [1abb35e]
- Updated dependencies [20e7146]
- Updated dependencies [cacc6be]
- Updated dependencies [e919523]
- Updated dependencies [dd8ce7d]
- Updated dependencies [3aa2fdc]
- Updated dependencies [20e7146]
- Updated dependencies [0b22265]
- Updated dependencies [c89d542]
- Updated dependencies [3e28485]
- Updated dependencies [1abb35e]
  - @msgly/core@1.1.0
