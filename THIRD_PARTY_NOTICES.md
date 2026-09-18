# Third-party references

- [jumpbyte-bot](https://github.com/sisi0318/jumpbyte-bot), GPL-3.0. Referenced for observed
  Douyin IM protocol flows, message shapes, Android Frontier connection parameters, media container
  formats, and VOD/TOS upload sequencing.
- [oicq](https://github.com/takayama-lily/oicq), MPL-2.0. Referenced for the public client/contact/message
  architecture pattern (`Client`, `Friend`, `Group`, `Member`, `sendMsg`, and hierarchical events).
- [DouYin_Spider](https://github.com/cv-cat/DouYin_Spider), revision
  `9afaf79580b1ee84e8954ff906ff26869d5b7f1f`. Referenced for inbound wire message types,
  URL-only image resources, voice URL lists, shared-work card fields, response diagnostics,
  session synchronization, request deadlines, PC IM card/file fields, and read-only main-site
  endpoint/signing conventions. No upstream source files copied.

The TypeScript implementation in this repository is independently structured around its existing
interfaces and uses platform/standard protocol primitives rather than copied upstream source files.
