# png-squeeze: Screenshots to the Smallest PNG — Palette, Grey and Alpha Forms Screened by Real Deflate Size

[![make.fun entry](https://img.shields.io/badge/make.fun-png--squeeze--01-blue)](https://make.fun/bounty/png-squeeze-01-run-20261127)

A lossless PNG re-compressor for 1280x720 RGBA screenshots (make.fun
`png-squeeze-01-run-20261127`). For each screenshot it tries every exact
colour form — palette (colour type 3, three palette orders) when the image
has at most 256 colours, grey (0), grey+alpha (4), RGB (2) or RGBA (6),
with a tRNS key when one transparent value keys the image — filters each
form several ways (fixed filters and per-row adaptive minimum-sum and
minimum-entropy choices), screens the candidates by their real zlib size,
and writes the smallest PNG. Every pixel, including a fully transparent
pixel's colour, decodes exactly as the input.

Runs as `node main.ts` on Node 22, built-in modules only.
