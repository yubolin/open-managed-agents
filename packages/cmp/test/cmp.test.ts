import { describe, expect, it } from "vitest";
import { FakeCmpConnector } from "../src/test-fakes.js";
import {
  automationExecuteSchema,
  cmdbEntityQuerySchema,
  itsmCreateTicketSchema,
} from "../src/port.js";
import type { CmdbEntity } from "../src/domain.js";

function entity(partial: Partial<CmdbEntity>): CmdbEntity {
  return {
    id: "ent_1",
    entity_class: "host",
    hostname: "web-01",
    ip: "10.0.0.1",
    region: "cn-east",
    labels: {},
    owner_team: "sre",
    ...partial,
  };
}

describe("cmdbEntityQuerySchema", () => {
  it("requires one of entity_id / hostname / ip", () => {
    expect(cmdbEntityQuerySchema.safeParse({}).success).toBe(false);
    expect(cmdbEntityQuerySchema.safeParse({ hostname: "web-01" }).success).toBe(true);
    expect(cmdbEntityQuerySchema.safeParse({ ip: "10.0.0.1" }).success).toBe(true);
  });
});

describe("automationExecuteSchema", () => {
  it("requires an approval_id — the gate is part of the contract", () => {
    expect(
      automationExecuteSchema.safeParse({ runbook_id: "rb_restart_service" }).success,
    ).toBe(false);
    expect(
      automationExecuteSchema.safeParse({
        runbook_id: "rb_restart_service",
        approval_id: "apr_1",
      }).success,
    ).toBe(true);
  });

  it("defaults params to {}", () => {
    const parsed = automationExecuteSchema.parse({
      runbook_id: "rb",
      approval_id: "apr_1",
    });
    expect(parsed.params).toEqual({});
  });
});

describe("itsmCreateTicketSchema", () => {
  it("rejects empty titles", () => {
    expect(
      itsmCreateTicketSchema.safeParse({ title: "", description: "d", severity: "info" })
        .success,
    ).toBe(false);
  });
});

describe("FakeCmpConnector", () => {
  it("resolves entities by hostname and ip", async () => {
    const cmp = new FakeCmpConnector();
    cmp.entities.set("ent_1", entity({}));
    expect((await cmp.cmdb.getEntity({ hostname: "web-01" }))?.id).toBe("ent_1");
    expect((await cmp.cmdb.getEntity({ ip: "10.0.0.1" }))?.id).toBe("ent_1");
    expect(await cmp.cmdb.getEntity({ hostname: "nope" })).toBeNull();
  });

  it("returns topology edges in both directions", async () => {
    const cmp = new FakeCmpConnector();
    cmp.entities.set("ent_1", entity({}));
    cmp.entities.set("ent_2", entity({ id: "ent_2", hostname: "db-01", ip: "10.0.0.2" }));
    cmp.relationships.push({
      source_id: "ent_1",
      target_id: "ent_2",
      type: "connects_to",
    });
    expect(await cmp.cmdb.getRelationships("ent_2")).toHaveLength(1);
    expect(await cmp.cmdb.getRelationships("ent_1")).toHaveLength(1);
  });

  it("runs the ITSM ticket lifecycle", async () => {
    const cmp = new FakeCmpConnector();
    const t = await cmp.itsm.createTicket({
      title: "CPU high",
      description: "web-01 CPU 95%",
      severity: "warning",
    });
    expect(t.status).toBe("open");
    await cmp.itsm.appendNote(t.ticket_id, "分析: ...");
    await cmp.itsm.appendNote(t.ticket_id, "分析: ..."); // idempotent
    expect(cmp.ticketNotes.get(t.ticket_id)).toHaveLength(1);
    await cmp.itsm.updateStatus(t.ticket_id, "in_progress");
    expect((await cmp.itsm.getTicket(t.ticket_id))?.status).toBe("in_progress");
    expect((await cmp.itsm.appendNote("tkt_x", "n")).ok).toBe(false);
  });

  it("executes seeded runbooks and completes on poll", async () => {
    const cmp = new FakeCmpConnector();
    const runbooks = await cmp.automation.listRunbooks();
    expect(runbooks.length).toBeGreaterThanOrEqual(3);
    const first = await cmp.automation.execute({
      runbook_id: "rb_restart_service",
      params: { hostname: "web-01", service: "nginx" },
      approval_id: "apr_test",
    });
    expect(first.status).toBe("running");
    const polled = await cmp.automation.getExecution(first.execution_id);
    expect(polled?.status).toBe("succeeded");
    expect(polled?.output).toContain("restart-service");
    await expect(
      cmp.automation.execute({
        runbook_id: "rb_missing",
        params: {},
        approval_id: "apr_test",
      }),
    ).rejects.toThrow(/unknown runbook/);
  });

  it("autoComplete finishes executions immediately", async () => {
    const cmp = new FakeCmpConnector({ autoComplete: true });
    const exec = await cmp.automation.execute({
      runbook_id: "rb_disk_clean",
      params: { hostname: "web-01" },
      approval_id: "apr_test",
    });
    expect(exec.status).toBe("succeeded");
    expect(exec.output).toContain("approval_id=apr_test");
  });

  it("dry-run has no side effects", async () => {
    const cmp = new FakeCmpConnector();
    const res = await cmp.automation.dryRun("rb_scale_out", { service: "api" });
    expect(res.ok).toBe(true);
    expect(cmp.executions.size).toBe(0);
  });
});
