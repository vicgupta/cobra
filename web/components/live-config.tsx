// Server components that read the server env file at request time.
import "server-only";
import { connection } from "next/server";
import { AuthBadge } from "./badges";
import { agentModes, envFilePath } from "@/lib/env-file";
import type { AgentId } from "@/lib/types";

export async function LiveAuthBadge({ agent }: { agent: AgentId }) {
  await connection();
  const modes = await agentModes();
  return <AuthBadge mode={modes[agent]} />;
}

export async function EnvFilePath() {
  await connection();
  return <code>{envFilePath()}</code>;
}
