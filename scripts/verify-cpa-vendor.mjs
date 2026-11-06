import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCpaSource } from "./prepare-vendor.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const version = validateCpaSource(path.join(root, "vendor", "win-x64", "cpa"));
  console.log(`Verified CPA ${version} and v8 management panel for packaging.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
