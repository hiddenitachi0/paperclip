# Third-party notices: Paperclip render worker

The render worker's own code (`src/`, `test/`, this folder's Dockerfile) is
part of Paperclip and under Paperclip's MIT licence. The image it builds
installs the software below. None of it is copied into the Paperclip
repository; it is installed from the npm registry (exact versions in
`package-lock.json`) or from Debian when the image is built.

## Hyperframes (the renderer)

- Package: `hyperframes` 0.8.150 (npm), source https://github.com/heygen-com/hyperframes, tag `v0.8.150`
- Licence: Apache License 2.0, Copyright 2026 HeyGen, Inc.
- Full licence text: [`licenses/hyperframes-LICENSE.txt`](licenses/hyperframes-LICENSE.txt), copied unchanged from the
  `LICENSE` file at that tag (sha256 `4259155fb06f127687ee7b0a8a3682d45132db0f2da26cbc0b7a2d1e796436b8`).
- NOTICE: the upstream repository has no `NOTICE` file at that tag (checked 27 Oct 2026). Its `CREDITS.md` names
  third-party pieces used by parts of Hyperframes the worker does not run (the studio, the speech model, the 3D
  catalog pieces).
- Not modified. The worker runs the published CLI (`hyperframes check`, `snapshot`, `render`) as a separate process.
- Not Remotion: Hyperframes is an independent implementation (see its `CREDITS.md`).

## chrome-headless-shell (the browser)

- Version 152.0.7977.30 for Linux x64, the build Hyperframes 0.8.150 pins. Downloaded once by
  `hyperframes browser ensure` while the image is built, from Google's Chrome for Testing storage.
- Licence: Chromium's BSD-style licence and the third-party licences shipped inside the download.

## Other npm packages

Hyperframes' own dependencies, at the versions in `package-lock.json`: MIT, ISC, Apache-2.0, BSD-2/3-Clause,
0BSD and CC0-1.0, plus `sharp`'s prebuilt `libvips` binaries (`@img/sharp-libvips-*`), which are
LGPL-3.0-or-later and loaded as a separate shared library, unmodified.

## Debian packages

`ffmpeg`, the browser's system libraries and the fonts (Inter, Liberation, DejaVu, Noto, Noto Color Emoji) come
from Debian bookworm with their own licences (`/usr/share/doc/*/copyright` inside the image).

## GSAP (optional, off by default)

GSAP is **not** in the image unless it is built with `--build-arg WITH_GSAP=1`. GSAP 3.x is published under
GreenSock's "Standard 'no charge' license" (https://gsap.com/standard-license), which is free to use but is not an
open-source licence. Turn it on only after deciding that licence is acceptable for this use. When it is on, the
worker serves `https://cdn.jsdelivr.net/npm/gsap@<version>/dist/<file>.min.js` script addresses from the local copy
instead of the network.
