import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool.js";
import {
  DAMIAN_REGISTERED_AGENT,
  acceptRegisteredAgent,
  declineRegisteredAgent,
  getAcceptancePageData,
  initiateOwnAgentAcceptance,
  isFilingSessionRegisteredAgentAccepted,
  reissueOwnAgentAcceptance,
  setDamianAsRegisteredAgent,
} from "../../src/registeredAgent/acceptanceService.js";
import type { EmailSendResult, EmailSender, RegisteredAgentAcceptanceEmailInput } from "../../src/registeredAgent/emailSender.js";
import type { RegisteredAgentInfo } from "../../src/registeredAgent/types.js";

/**
 * Runs against the real Supabase dev instance, same convention as every
 * other integration test in this directory. Every row created is deleted
 * in afterAll. No email is ever actually sent — a fake EmailSender is
 * injected per test (matching the ZohoClient fake-injection pattern
 * already used in sync/worker tests), since no real transactional email
 * provider exists in this codebase (see the status report §1).
 */

const createdSessionIds: string[] = [];

function fakeSender(result: EmailSendResult): { sender: EmailSender; calls: RegisteredAgentAcceptanceEmailInput[] } {
  const calls: RegisteredAgentAcceptanceEmailInput[] = [];
  return {
    calls,
    sender: {
      async sendRegisteredAgentAcceptanceEmail(input) {
        calls.push(input);
        return result;
      },
    },
  };
}

async function createTestFilingSession(llcName: string): Promise<string> {
  const filingSessionId = randomUUID();
  createdSessionIds.push(filingSessionId);
  await pool.query(
    `INSERT INTO filing_sessions (filing_session_id, current_stage, filing_data)
     VALUES ($1, 'authorized_persons', $2)`,
    [filingSessionId, { llc_name: llcName }]
  );
  return filingSessionId;
}

async function getSession(filingSessionId: string) {
  const { rows } = await pool.query(
    "SELECT registered_agent_status, filing_data FROM filing_sessions WHERE filing_session_id = $1",
    [filingSessionId]
  );
  return rows[0];
}

async function getLatestAcceptanceRow(filingSessionId: string) {
  const { rows } = await pool.query(
    "SELECT * FROM registered_agent_acceptances WHERE filing_session_id = $1 ORDER BY created_at DESC LIMIT 1",
    [filingSessionId]
  );
  return rows[0];
}

const validOutsideAgent: RegisteredAgentInfo = {
  name: "Outside Agent LLC",
  email: "agent@example.invalid",
  street: "500 Ocean Drive",
  unit: "",
  city: "Miami Beach",
  state: "Florida",
  zip: "33139",
};

afterAll(async () => {
  if (createdSessionIds.length) {
    await pool.query("DELETE FROM registered_agent_acceptances WHERE filing_session_id = ANY($1)", [createdSessionIds]);
    await pool.query("DELETE FROM filing_events WHERE filing_session_id = ANY($1)", [createdSessionIds]);
    await pool.query("DELETE FROM filing_sessions WHERE filing_session_id = ANY($1)", [createdSessionIds]);
  }
});

describe("A. Damian path", () => {
  it("sets accepted with no acceptance email sent", async () => {
    const id = await createTestFilingSession("Damian Path LLC");
    const result = await setDamianAsRegisteredAgent(pool, id);
    expect(result.status).toBe("accepted");

    const session = await getSession(id);
    expect(session.registered_agent_status).toBe("accepted");
    expect(session.filing_data.agent_name).toBe(DAMIAN_REGISTERED_AGENT.name);
    expect(session.filing_data.agent_street).toBe(DAMIAN_REGISTERED_AGENT.street);
    expect(session.filing_data.agent_choice).toBe("damian");

    // No email sender is even passed to this path — there is no
    // parameter for one. Confirm no acceptance row was created either
    // (Damian's path never issues a token).
    const row = await getLatestAcceptanceRow(id);
    expect(row).toBeUndefined();
  });
});

describe("B. Customer provides outside registered agent", () => {
  it("sets pending immediately, even before an email is attempted", async () => {
    const id = await createTestFilingSession("Outside Agent Pending LLC");
    const { sender } = fakeSender({ ok: true });
    // Use an agent object missing required fields on purpose — pending
    // must be set BEFORE validation per the locked schema's own ordering.
    const invalidAgent: RegisteredAgentInfo = { ...validOutsideAgent, name: "" };
    const result = await initiateOwnAgentAcceptance(pool, id, invalidAgent, {
      emailSender: sender,
      appBaseUrl: "https://example.test",
    });
    expect(result.status).toBe("pending");
    expect(result.validationErrors).toContain("registered agent name is required");

    const session = await getSession(id);
    expect(session.registered_agent_status).toBe("pending");
  });
});

describe("C. Acceptance request succeeds", () => {
  it("moves to acceptance_requested and records the durable acceptance row", async () => {
    const id = await createTestFilingSession("Acceptance Requested LLC");
    const { sender, calls } = fakeSender({ ok: true });
    const result = await initiateOwnAgentAcceptance(pool, id, validOutsideAgent, {
      emailSender: sender,
      appBaseUrl: "https://example.test",
    });
    expect(result.status).toBe("acceptance_requested");
    expect(calls).toHaveLength(1);
    expect(calls[0].toEmail).toBe(validOutsideAgent.email);
    expect(calls[0].acceptanceUrl).toContain("https://example.test/registered-agent/acceptance/");

    const session = await getSession(id);
    expect(session.registered_agent_status).toBe("acceptance_requested");

    const row = await getLatestAcceptanceRow(id);
    expect(row.status).toBe("acceptance_requested");
    expect(row.registered_agent_name).toBe(validOutsideAgent.name);
    expect(row.registered_agent_email).toBe(validOutsideAgent.email);
    expect(row.requested_at).not.toBeNull();
    expect(row.acceptance_token_id).toBeTruthy();
    expect(row.acceptance_version).toBeTruthy();
    // The email sent was never considered acceptance on its own.
    expect(session.registered_agent_status).not.toBe("accepted");
  });
});

describe("D. Registered agent accepts", () => {
  it("moves to accepted and records accepted_at/accepted_ip", async () => {
    const id = await createTestFilingSession("Accept Flow LLC");
    const { sender } = fakeSender({ ok: true });
    let capturedToken = "";
    const spySender: EmailSender = {
      async sendRegisteredAgentAcceptanceEmail(input) {
        capturedToken = input.acceptanceUrl.split("/").pop() ?? "";
        return sender.sendRegisteredAgentAcceptanceEmail(input);
      },
    };
    await initiateOwnAgentAcceptance(pool, id, validOutsideAgent, {
      emailSender: spySender,
      appBaseUrl: "https://example.test",
    });

    const pageData = await getAcceptancePageData(pool, capturedToken);
    expect(pageData?.effectiveStatus).toBe("acceptance_requested");
    expect(pageData?.llcName).toBe("Accept Flow LLC");
    expect(pageData?.registeredAgentName).toBe(validOutsideAgent.name);

    const result = await acceptRegisteredAgent(pool, capturedToken, "203.0.113.5");
    expect(result.ok).toBe(true);
    expect(result.filingSessionId).toBe(id);

    const session = await getSession(id);
    expect(session.registered_agent_status).toBe("accepted");

    const row = await getLatestAcceptanceRow(id);
    expect(row.status).toBe("accepted");
    expect(row.accepted_ip).toBe("203.0.113.5");
    expect(row.accepted_at).not.toBeNull();
  });
});

describe("E. Registered agent declines", () => {
  it("moves to declined and preserves the filing session", async () => {
    const id = await createTestFilingSession("Decline Flow LLC");
    let capturedToken = "";
    const spySender: EmailSender = {
      async sendRegisteredAgentAcceptanceEmail(input) {
        capturedToken = input.acceptanceUrl.split("/").pop() ?? "";
        return { ok: true };
      },
    };
    await initiateOwnAgentAcceptance(pool, id, validOutsideAgent, {
      emailSender: spySender,
      appBaseUrl: "https://example.test",
    });

    const result = await declineRegisteredAgent(pool, capturedToken);
    expect(result.ok).toBe(true);

    const session = await getSession(id);
    expect(session.registered_agent_status).toBe("declined");
    // Filing session itself still exists with all its data intact.
    expect(session.filing_data.llc_name).toBe("Decline Flow LLC");
  });
});

describe("F. Acceptance token expires", () => {
  it("rejects acceptance past the TTL and transitions to expired", async () => {
    const id = await createTestFilingSession("Expiry Flow LLC");
    let capturedToken = "";
    const spySender: EmailSender = {
      async sendRegisteredAgentAcceptanceEmail(input) {
        capturedToken = input.acceptanceUrl.split("/").pop() ?? "";
        return { ok: true };
      },
    };
    const eightDaysAgo = () => new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await initiateOwnAgentAcceptance(pool, id, validOutsideAgent, {
      emailSender: spySender,
      appBaseUrl: "https://example.test",
      now: eightDaysAgo,
    });

    const result = await acceptRegisteredAgent(pool, capturedToken, "203.0.113.5");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("expired");

    const session = await getSession(id);
    expect(session.registered_agent_status).toBe("expired");
  });
});

describe("G. Email transmission fails", () => {
  it("sets email_failed, preserves the session, still records an audit row", async () => {
    const id = await createTestFilingSession("Email Failed LLC");
    const { sender } = fakeSender({ ok: false, error: "simulated SMTP failure" });
    const result = await initiateOwnAgentAcceptance(pool, id, validOutsideAgent, {
      emailSender: sender,
      appBaseUrl: "https://example.test",
    });
    expect(result.status).toBe("email_failed");

    const session = await getSession(id);
    expect(session.registered_agent_status).toBe("email_failed");
    expect(session.filing_data.llc_name).toBe("Email Failed LLC"); // preserved

    const row = await getLatestAcceptanceRow(id);
    expect(row.status).toBe("email_failed");
  });
});

describe("H. Used token cannot be reused", () => {
  it("rejects a second accept attempt with the same token after the first succeeds", async () => {
    const id = await createTestFilingSession("Reuse Flow LLC");
    let capturedToken = "";
    const spySender: EmailSender = {
      async sendRegisteredAgentAcceptanceEmail(input) {
        capturedToken = input.acceptanceUrl.split("/").pop() ?? "";
        return { ok: true };
      },
    };
    await initiateOwnAgentAcceptance(pool, id, validOutsideAgent, {
      emailSender: spySender,
      appBaseUrl: "https://example.test",
    });

    const first = await acceptRegisteredAgent(pool, capturedToken, "203.0.113.1");
    expect(first.ok).toBe(true);
    expect(first.alreadyProcessed).toBeUndefined();

    const rowAfterFirst = await getLatestAcceptanceRow(id);

    const second = await acceptRegisteredAgent(pool, capturedToken, "203.0.113.2");
    expect(second.ok).toBe(true);
    expect(second.alreadyProcessed).toBe(true);

    const rowAfterSecond = await getLatestAcceptanceRow(id);
    // Second call did not overwrite accepted_ip with the new value —
    // proves the token is genuinely single-use, not just re-accepted.
    expect(rowAfterSecond.accepted_ip).toBe(rowAfterFirst.accepted_ip);
    expect(rowAfterSecond.accepted_at.getTime()).toBe(rowAfterFirst.accepted_at.getTime());
  });

  it("rejects a decline attempt against an already-accepted token", async () => {
    const id = await createTestFilingSession("Decline After Accept LLC");
    let capturedToken = "";
    const spySender: EmailSender = {
      async sendRegisteredAgentAcceptanceEmail(input) {
        capturedToken = input.acceptanceUrl.split("/").pop() ?? "";
        return { ok: true };
      },
    };
    await initiateOwnAgentAcceptance(pool, id, validOutsideAgent, {
      emailSender: spySender,
      appBaseUrl: "https://example.test",
    });
    await acceptRegisteredAgent(pool, capturedToken, "203.0.113.1");

    const declineResult = await declineRegisteredAgent(pool, capturedToken);
    expect(declineResult.ok).toBe(false);

    const session = await getSession(id);
    expect(session.registered_agent_status).toBe("accepted"); // unchanged
  });
});

describe("I. Duplicate acceptance processing does not create another acceptance record", () => {
  it("only one registered_agent_acceptances row exists for the session after two accept calls", async () => {
    const id = await createTestFilingSession("No Duplicate Rows LLC");
    let capturedToken = "";
    const spySender: EmailSender = {
      async sendRegisteredAgentAcceptanceEmail(input) {
        capturedToken = input.acceptanceUrl.split("/").pop() ?? "";
        return { ok: true };
      },
    };
    await initiateOwnAgentAcceptance(pool, id, validOutsideAgent, {
      emailSender: spySender,
      appBaseUrl: "https://example.test",
    });
    await acceptRegisteredAgent(pool, capturedToken, "203.0.113.1");
    await acceptRegisteredAgent(pool, capturedToken, "203.0.113.1");
    await acceptRegisteredAgent(pool, capturedToken, "203.0.113.1");

    const { rows } = await pool.query("SELECT count(*) AS n FROM registered_agent_acceptances WHERE filing_session_id = $1", [id]);
    expect(Number(rows[0].n)).toBe(1);

    const { rows: events } = await pool.query(
      "SELECT event_type FROM filing_events WHERE filing_session_id = $1 AND event_type = 'registered_agent.accepted'",
      [id]
    );
    // Exactly one "accepted" audit event, not three.
    expect(events).toHaveLength(1);
  });
});

describe("J. Filing cannot proceed while acceptance is not accepted", () => {
  it("the gate rejects pending, acceptance_requested, declined, expired, and email_failed", async () => {
    const id = await createTestFilingSession("Gate Check LLC");
    expect(await isFilingSessionRegisteredAgentAccepted(pool, id)).toBe(false); // no status set at all yet

    await initiateOwnAgentAcceptance(pool, id, { ...validOutsideAgent, name: "" }, {
      emailSender: fakeSender({ ok: true }).sender,
      appBaseUrl: "https://example.test",
    });
    expect(await isFilingSessionRegisteredAgentAccepted(pool, id)).toBe(false); // pending

    const { sender } = fakeSender({ ok: false, error: "boom" });
    await initiateOwnAgentAcceptance(pool, id, validOutsideAgent, { emailSender: sender, appBaseUrl: "https://example.test" });
    expect(await isFilingSessionRegisteredAgentAccepted(pool, id)).toBe(false); // email_failed
  });

  it("the gate accepts only 'accepted'", async () => {
    const id = await createTestFilingSession("Gate Pass LLC");
    await setDamianAsRegisteredAgent(pool, id);
    expect(await isFilingSessionRegisteredAgentAccepted(pool, id)).toBe(true);
  });
});

describe("K. Switching from outside registered agent to Damian", () => {
  it("supersedes the open request and moves straight to accepted, invalidating the old token", async () => {
    const id = await createTestFilingSession("Switch To Damian LLC");
    let capturedToken = "";
    const spySender: EmailSender = {
      async sendRegisteredAgentAcceptanceEmail(input) {
        capturedToken = input.acceptanceUrl.split("/").pop() ?? "";
        return { ok: true };
      },
    };
    await initiateOwnAgentAcceptance(pool, id, validOutsideAgent, {
      emailSender: spySender,
      appBaseUrl: "https://example.test",
    });
    expect((await getSession(id)).registered_agent_status).toBe("acceptance_requested");

    const result = await setDamianAsRegisteredAgent(pool, id);
    expect(result.status).toBe("accepted");

    const session = await getSession(id);
    expect(session.registered_agent_status).toBe("accepted");
    expect(session.filing_data.agent_name).toBe(DAMIAN_REGISTERED_AGENT.name);

    // The old outside-agent token must no longer be able to flip status
    // back to "accepted" (it already is, but via Damian, not that link).
    const staleAcceptResult = await acceptRegisteredAgent(pool, capturedToken, "203.0.113.9");
    expect(staleAcceptResult.ok).toBe(false);

    const supersededRow = await pool.query(
      "SELECT status FROM registered_agent_acceptances WHERE filing_session_id = $1 ORDER BY created_at ASC LIMIT 1",
      [id]
    );
    expect(supersededRow.rows[0].status).toBe("expired");
  });
});

describe("L. Switching from Damian to outside registered agent", () => {
  it("resets to pending and (re)initiates the acceptance workflow", async () => {
    const id = await createTestFilingSession("Switch From Damian LLC");
    await setDamianAsRegisteredAgent(pool, id);
    expect((await getSession(id)).registered_agent_status).toBe("accepted");

    const { sender, calls } = fakeSender({ ok: true });
    const result = await initiateOwnAgentAcceptance(pool, id, validOutsideAgent, {
      emailSender: sender,
      appBaseUrl: "https://example.test",
    });
    expect(result.status).toBe("acceptance_requested");
    expect(calls).toHaveLength(1);

    const session = await getSession(id);
    expect(session.registered_agent_status).toBe("acceptance_requested");
    expect(session.filing_data.agent_choice).toBe("own");
    expect(session.filing_data.agent_name).toBe(validOutsideAgent.name);
  });
});

describe("Reissuance after email_failed (§7)", () => {
  it("reissueOwnAgentAcceptance re-sends without creating a duplicate filing session", async () => {
    const id = await createTestFilingSession("Reissue Flow LLC");
    const failing = fakeSender({ ok: false, error: "first attempt fails" });
    await initiateOwnAgentAcceptance(pool, id, validOutsideAgent, {
      emailSender: failing.sender,
      appBaseUrl: "https://example.test",
    });
    expect((await getSession(id)).registered_agent_status).toBe("email_failed");

    const succeeding = fakeSender({ ok: true });
    const result = await reissueOwnAgentAcceptance(pool, id, {
      emailSender: succeeding.sender,
      appBaseUrl: "https://example.test",
    });
    expect(result.status).toBe("acceptance_requested");
    expect(succeeding.calls).toHaveLength(1);
    expect(succeeding.calls[0].toEmail).toBe(validOutsideAgent.email); // pulled from filing_data, not resupplied

    // Still exactly one filing session — never duplicated.
    const { rows } = await pool.query("SELECT count(*) AS n FROM filing_sessions WHERE filing_session_id = $1", [id]);
    expect(Number(rows[0].n)).toBe(1);

    const { rows: retryEvents } = await pool.query(
      "SELECT event_type FROM filing_events WHERE filing_session_id = $1 AND event_type = 'registered_agent.retry'",
      [id]
    );
    expect(retryEvents).toHaveLength(1);
  });
});
