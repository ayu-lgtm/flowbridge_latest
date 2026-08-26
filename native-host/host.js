#!/usr/bin/env node
import clipboard from "clipboardy";

function readMessages(onMessage) {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const len = buffer.readUInt32LE(0);
      if (buffer.length < 4 + len) break;
      const body = buffer.subarray(4, 4 + len).toString("utf8");
      buffer = buffer.subarray(4 + len);
      try {
        onMessage(JSON.parse(body));
      } catch (err) {
        sendMessage({ ok: false, error: "bad-json: " + String(err) });
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

function sendMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(header);
  process.stdout.write(json);
}

readMessages(async (msg) => {
  try {
    if (msg?.type === "read") {
      const text = await clipboard.read();
      sendMessage({ ok: true, text });
    } else if (msg?.type === "write") {
      await clipboard.write(String(msg.text ?? ""));
      sendMessage({ ok: true });
    } else if (msg?.type === "ping") {
      sendMessage({ ok: true, pong: true });
    } else {
      sendMessage({ ok: false, error: "unknown message type" });
    }
  } catch (err) {
    sendMessage({ ok: false, error: String(err) });
  }
});