import { createBscWorkerMailbox } from "../../src/bsc-worker-mailbox.js";
// Test-only supervised child: no configuration import, network or alert sender.
if (process.send) {
  const mailbox = createBscWorkerMailbox(process.env.DATA_DIR);
  if (!mailbox.claimOwner()) throw new Error("fixture owner already held");
  let processing = false;
  const pending = new Map();
  process.on("message", (message) => {
    if (message.kind === "callback-result") pending.get(message.id)?.(message);
  });
  const timer = setInterval(async () => {
    if (processing) return;
    const row = mailbox.next();
    if (!row) return;
    processing = true;
    try {
      const args = JSON.parse(row.args);
      if (args[0]?.[0]?.wait) return;
      let result = { accepted: true, method: row.method, args };
      if (args[0]?.[0]?.alert) {
        result = await new Promise((resolve) => {
          pending.set(row.id, resolve);
          process.send({ kind: "callback", id: row.id, method: "alert", event: { type: "fixture-alert" } });
        });
      }
      mailbox.complete(row.id, result);
    } finally { processing = false; }
  }, 10);
  process.on("SIGTERM", () => { clearInterval(timer); mailbox.releaseOwner(); mailbox.close(); process.disconnect(); });
}
