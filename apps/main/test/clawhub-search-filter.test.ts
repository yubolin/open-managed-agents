// P1 review 2026-08-20: searchClawHubSkills must actually filter by `q`
// locally — the upstream registry is currently returning the same 25
// items regardless of query (verified 2026-08-20), which means the
// tool silently serves irrelevant results. The contract: filter on
// slug/name/description; case-insensitive; no match → empty array;
// pagination cap (50 max) so the LLM never gets an unbounded list.

import { describe, it, expect } from "vitest";
import {
  searchClawHubSkills,
  type ClawHubSkill,
} from "../src/lib/clawhub";

const sample: ClawHubSkill[] = [
  {
    slug: "ops-monitor",
    name: "Ops Monitor",
    description: "monitoring dashboards for k8s clusters",
    version: "1.0.0",
    owner: "oma",
    is_official: true,
    verification_tier: "verified",
    downloads: 100,
  },
  {
    slug: "k8s-runbook",
    name: "K8s Runbook",
    description: "incident response playbooks for kubernetes",
    version: "2.1.0",
    owner: "acme",
    is_official: false,
    verification_tier: null,
    downloads: 50,
  },
  {
    slug: "weather-skill",
    name: "Weather",
    description: "fetch forecast by city",
    version: "1.2.0",
    owner: "weather",
    is_official: false,
    verification_tier: null,
    downloads: 10,
  },
];

function fetchAll() {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/packages")) {
      return new Response(
        JSON.stringify({
          items: sample.map((s) => ({
            name: s.slug,
            displayName: s.name,
            summary: s.description,
            family: "skill",
            latestVersion: s.version,
            ownerHandle: s.owner,
            isOfficial: s.is_official,
            verificationTier: s.verification_tier,
            stats: { downloads: s.downloads },
          })),
        }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("searchClawHubSkills — local q filter (P1 review 2026-08-20)", () => {
  it("filter on slug: matches a single skill, excludes the rest", async () => {
    const out = await searchClawHubSkills("ops-monitor", fetchAll());
    expect(out.map((s) => s.slug)).toEqual(["ops-monitor"]);
  });

  it("filter on description substring: 'k8s' matches both k8s items", async () => {
    const out = await searchClawHubSkills("k8s", fetchAll());
    expect(out.map((s) => s.slug).sort()).toEqual(["k8s-runbook", "ops-monitor"].sort());
  });

  it("filter is case-insensitive", async () => {
    const out = await searchClawHubSkills("K8S", fetchAll());
    expect(out.map((s) => s.slug).sort()).toEqual(["k8s-runbook", "ops-monitor"].sort());
  });

  it("no match → empty array (never fabricates fallback results)", async () => {
    const out = await searchClawHubSkills("zzz-no-such-thing", fetchAll());
    expect(out).toEqual([]);
  });

  it("empty q returns the full list up to cap", async () => {
    const out = await searchClawHubSkills("", fetchAll());
    expect(out.length).toBe(3);
  });

  it("multi-word q: all tokens must match (logical AND across fields)", async () => {
    // 'kubernetes incident' → only k8s-runbook description contains both
    const out = await searchClawHubSkills("kubernetes incident", fetchAll());
    expect(out.map((s) => s.slug)).toEqual(["k8s-runbook"]);
  });

  it("pagination cap: max 50 results even when upstream returns more", async () => {
    const big = Array.from({ length: 200 }, (_, i) => ({
      slug: `s${i}`,
      name: `S${i}`,
      description: `common-token everywhere ${i}`,
      version: "1.0.0",
      owner: "x",
      is_official: false,
      verification_tier: null,
      downloads: 0,
    }));
    const fetchBig = (async () =>
      new Response(
        JSON.stringify({
          items: big.map((s) => ({
            name: s.slug,
            displayName: s.name,
            summary: s.description,
            family: "skill",
            latestVersion: s.version,
            ownerHandle: s.owner,
            isOfficial: s.is_official,
            verificationTier: s.verification_tier,
            stats: { downloads: s.downloads },
          })),
        }),
        { status: 200 },
      )) as typeof fetch;
    const out = await searchClawHubSkills("common-token", fetchBig);
    expect(out.length).toBeLessThanOrEqual(50);
  });
});