import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { AgentsTabs } from "@/components/agents-tabs";
import { PageHeader } from "@/components/page-header";
import { LessonsBoard } from "@/components/lessons";
import { actor, getDb } from "@/lib/workflows/server";
import { lessonsView } from "@/lib/lessons/service";

export const metadata = { title: "Lessons · Agents · Cobra" };

/** Agents / Lessons: what your team's runs taught, per repo. Leads review; everyone can read and comment. */
export default function LessonsPage({ searchParams }: { searchParams: Promise<{ lesson?: string; repo?: string; tab?: string }> }) {
  return (
    <div className="space-y-6">
      <PageHeader title="Agents" description="Lessons your team's runs taught, per repo. Approved lessons are added to future runs in the same repo." />
      <AgentsTabs active="lessons" />
      <Suspense fallback={<p className="text-sm text-subtle">Loading…</p>}>
        <AuthGate>{(su) => <Body su={su} searchParams={searchParams} />}</AuthGate>
      </Suspense>
    </div>
  );
}

async function Body({ su, searchParams }: { su: Parameters<typeof actor>[0]; searchParams: Promise<{ lesson?: string; repo?: string; tab?: string }> }) {
  const sp = await searchParams;
  const v = lessonsView(getDb(), actor(su), "all");
  return <LessonsBoard initial={v} focus={Number(sp.lesson) || null} initialRepo={sp.repo ?? ""} initialTab={sp.tab === "history" ? "history" : "queue"} />;
}
