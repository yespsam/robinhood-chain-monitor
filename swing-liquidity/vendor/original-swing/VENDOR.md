# Vendored original swing

The files in this directory are the untracked Mac sources supplied with the task, copied verbatim so the original paper strategy stays readable inside this bundle.

They are not the process this bundle starts. `scripts/paper.js` does not import `scripts/swing-paper.js`. The vendored entry still pins its ledger to `data/swing`; do not point a LaunchAgent at it when running the liquidity strategy.

`src/swing-flap.js` is imported read-only by the new runtime for Flap Portal logs and `getTokenV8Safe`. It does not sign or send transactions.
