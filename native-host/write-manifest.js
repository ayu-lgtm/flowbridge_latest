import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const extensionId = process.argv[2];

if (!extensionId || extensionId.length < 10) {
  console.error("Usage: node write-manifest.js <extensionId>");
  process.exit(1);
}

const manifest = {
  name: "com.flowbridge.clipboard",
  description: "FlowBridge background clipboard bridge",
  path: join(here, "host.bat"),
  type: "stdio",
  allowed_origins: [`chrome-extension://${extensionId}/`],
};

const manifestPath = join(here, "com.flowbridge.clipboard.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
console.log("Manifest written to: " + manifestPath);