// A scripted stand-in for the Python voice sidecar. It speaks the same
// JSON-lines protocol: "hears" the lines in KIRA_FAKE_HEAR (JSON array of
// {after, event}) and records every command it is sent to KIRA_FAKE_LOG.
const fs = require("node:fs");
const readline = require("node:readline");

const log = process.env.KIRA_FAKE_LOG;
const script = JSON.parse(process.env.KIRA_FAKE_HEAR || "[]");
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");

emit({ type: "ready", input: "fake mic", output: "fake speaker", wake: "fake", voice: "fake" });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (log) fs.appendFileSync(log, line + "\n");
  const cmd = JSON.parse(line);
  // Hearing is gated on what the daemon says, like a person replying to a question.
  for (const s of script) {
    if (!s.sent && s.whenSaid && cmd.type === "say" && new RegExp(s.whenSaid, "i").test(cmd.text)) {
      s.sent = true;
      setTimeout(() => emit(s.event), s.after || 0);
    }
  }
});
for (const s of script) {
  if (!s.whenSaid) setTimeout(() => emit(s.event), s.after || 0);
}
process.stdin.on("end", () => process.exit(0));
