# QR encoder provenance

The unmodified `qrcode.mjs` and `qrcode_UTF8.mjs` files are from npm `qrcode-generator@2.0.4` (Kazuhiko Arase), under the MIT license. See `qrcode-generator-LICENSE` and the retained source copyright notices.

Source: https://github.com/kazuhikoarase/qrcode-generator
Registry archive: https://registry.npmjs.org/qrcode-generator/-/qrcode-generator-2.0.4.tgz
Registry integrity: `sha512-mZSiP6RnbHl4xL2Ap5HfkjLnmxfKcPWpWe/c+5XxCuetEenqmNFf1FH/ftXPCtFG5/TDobjsjz6sSNL0Sr8Z9g==`

The dashboard uses the encoder locally in the browser. No remote QR generation service receives authentication links. Only the explicit two module paths are served; this directory is not exposed as a file browser.
