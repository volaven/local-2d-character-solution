# LivLiv Player provenance

Upstream: [livliv-dev/player](https://github.com/livliv-dev/player), Apache-2.0, commit `0f2c8871de375dfe4d239fab480e07f6d9b032dd`.

Unmodified copies from that commit:

| File | SHA-256 |
| --- | --- |
| `LICENSE` | `3ddf9be5c28fe27dad143a5dc76eea25222ad1dd68934a047064e56ed2fa40c5` |
| `NOTICE` | `df3f4ccaa1b7c80f1cdb0545718ffc6dc1d6479a1963c9f06f256f9177d810b4` |
| `schema/livliv-model-v4.json` | `caa739d6126dd4970ce6dd358832dd10d7cf62a21afca61f2f6887b4218c4cb4` |
| `FORMAT.md` | `ee3ddea94f9a554ce4485ddbdb5aaf4918b4e38c5fac62e05326a502420f7e09` |

`src/pack/zip.mjs` adapts `scripts/pack-characters.mjs` and retains a source change notice. `build-surprise-player.mjs` applies a small expression eye-layer visibility patch to npm package `@livliv-dev/player@0.3.0` at installation time; the generated file is not committed. Upstream character art is excluded.
