import type { SandboxSettings } from "@anthropic-ai/claude-agent-sdk";

/** Official Bash sandbox, with normal room approvals and no unsandboxed retry. */
export function roomSandboxSettings(): SandboxSettings {
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    excludedCommands: [],
    filesystem: { disabled: false },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
  };
}
