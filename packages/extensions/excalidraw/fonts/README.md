# Excalidraw fonts shipped with the extension

Excalidraw loads each font face by URL, from `window.EXCALIDRAW_ASSET_PATH`
when it is set and otherwise from the esm.sh CDN. Offline, or behind a CSP that
blocks the CDN, it falls back to a narrower system font and labels measured in
it clip. So the extension ships the faces and points the asset path at them
(see `activate` in `src/index.tsx`).

The `.woff2` files are not kept here. The build copies them unmodified from
`@excalidraw/excalidraw` (`dist/prod/fonts/<Family>/`) into
`dist/fonts/<Family>/`, next to that family's `LICENSE.txt` from this folder
(`copyExcalidrawFonts` in `vite.config.ts`). A family ships only when its
license sits here, and the build fails if Excalidraw stops shipping it.

| Folder | Face | License |
| --- | --- | --- |
| Excalifont | Excalifont | SIL OFL 1.1 |
| Virgil | Virgil | SIL OFL 1.1 |
| Nunito | Nunito | SIL OFL 1.1 |
| Lilita | Lilita One | SIL OFL 1.1 |
| Cascadia | Cascadia Code | SIL OFL 1.1 |
| ComicShanns | Comic Shanns | MIT |
| Xiaolai | Xiaolai SC (CJK) | SIL OFL 1.1 |

Deliberately not shipped:

- **Liberation Sans.** The file Excalidraw bundles is version 1.05, whose only
  license text points to "the license agreement under which you accepted the
  Liberation font software" (the 1.x line is GPLv2 with a font exception, not
  OFL). It keeps loading from the CDN.
- **Assistant**, the UI font. Only Excalidraw's CSS uses it, and the build
  already inlines those files into `dist/index.css`.
