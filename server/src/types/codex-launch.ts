export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexExecLaunchInput {
  model?: string;
  profile?: string;
  sandbox?: CodexSandboxMode;
  additionalWritableRoots?: string[];
  /** Maps to --enable/--disable fast_mode when not default */
  speed?: "default" | "fast" | "deep";
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  enableFeatures?: string[];
  disableFeatures?: string[];
}
