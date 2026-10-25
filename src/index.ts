export const NAME = "Cobra";
export const EXPANSION = "Command Orchestration for Build and Release Automation";

export * from "./agents/index.js";
export * from "./config/env-file.js";

export function banner(): string {
  return `${NAME}: ${EXPANSION}`;
}

console.log(banner());
