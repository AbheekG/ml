# Visual identity and compact app shell

## Decision

Music Library keeps its existing warm, restrained visual language. This pass
does not introduce a new theme, navigation model, or decorative illustration
system. It gives the application one consistent, technically correct identity
and reduces avoidable mobile chrome.

The identity is a cream music note on the existing deep terracotta accent:

- `public/icon.svg` is the reviewed full-bleed source and browser favicon;
- opaque 192 px and 512 px PNG fallbacks serve ordinary PWA surfaces;
- separate opaque maskable PNGs keep the complete note inside Android's 40%
  safe circle;
- the opaque 180 px Apple touch icon has no baked-in rounded rectangle, border,
  or shadow because iOS supplies its own Home Screen mask; and
- the app header uses the same SVG instead of a separate letter mark.

WebKit gives an explicit `apple-touch-icon` precedence over manifest icons, so
both paths must be correct. Chromium-based Android launchers use the dedicated
`purpose: "maskable"` entries rather than shrinking an ordinary icon onto a
fallback background. References:
[WebKit Home Screen web apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
and [maskable PWA icons](https://web.dev/articles/maskable-icon).

The header is 56 px high instead of 72 px. While online it is part of the normal
document flow and scrolls away; the fixed bottom navigation already provides
persistent access to the main destinations. While offline the header remains
sticky so the required **Offline · read only** state cannot silently disappear.
Desktop detail sidebars now use the viewport edge, rather than reserving space
for a header that is no longer sticky.

## Installation and acceptance

Installed operating-system icons are cached at installation time. After this
change reaches protected staging, test a fresh installation:

1. remove the existing Home Screen installation on the test device;
2. open the protected app and complete Access sign-in;
3. add it to the Home Screen again;
4. confirm the terracotta/cream icon on current iOS Safari and Android Chrome;
5. launch it and confirm standalone mode;
6. confirm the online header scrolls away while bottom navigation remains;
7. take the device offline and confirm the compact offline header stays visible.

The installation check uses the real protected application but does not require
catalog mutation, an export plan, media access, production/DNS work, or a new
archive.
