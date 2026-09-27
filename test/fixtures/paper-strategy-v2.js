// Offline deterministic fixtures only. Never loaded by the running application.
export function breakoutCandles(nowMs) {
  const end = Math.floor(nowMs / 60000) * 60000;
  return [
    [.72, .86, .70, .85, 100], [.85, .91, .83, .90, 100],
    [.90, .93, .89, .92, 100], [.92, .95, .90, .94, 100],
    [.94, .96, .92, .94, 100], [.94, .95, .92, .93, 100],
    [.94, 1.01, .93, .99, 180], [.99, 1.02, .955, 1.00, 160],
  ].map(([open, high, low, close, volume], i) => ({ time: end - (8 - i) * 60000, open, high, low, close, volume }));
}

export function sourcedNarrative(nowMs, chain, address) {
  return { status: 'sourced', caBound: true, chain, address,
    sourceAt: new Date(nowMs).toISOString(), sourceUrl: 'https://x.com/fixture/status/1234567890',
    text: 'The agent game product has launched a public test with an on-chain demonstration.',
    sourceKind: 'authenticated_x', sourceAuthenticated: true, authorKey: 'x-id:1234', authorLabel: 'fixture' };
}
