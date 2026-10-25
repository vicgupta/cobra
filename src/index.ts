export const NAME = "Cobra";
export const EXPANSION = "Command Orchestration for Build and Release Automation";

export function banner(): string {
  return `${NAME}: ${EXPANSION}`;
}

console.log(banner());
