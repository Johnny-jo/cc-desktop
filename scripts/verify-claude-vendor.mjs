import { verifyClaudeVendor } from "./claude-vendor.mjs";
try {
  const result = verifyClaudeVendor();
  console.log(`Verified Claude Code ${result.claudeVersion} / Agent SDK ${result.claudeSdkVersion}, including binary SHA256.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
