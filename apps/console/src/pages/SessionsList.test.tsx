import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { I18nProvider } from "../i18n";
import { server } from "../mocks/server";
import { SessionsList } from "./SessionsList";

function ShellWrapper() {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  return (
    <div>
      <div ref={setSlot} />
      <Outlet context={{ pageHeaderSlot: slot }} />
    </div>
  );
}

function renderSessionsList() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/sessions"]}>
          <Routes>
            <Route element={<ShellWrapper />}>
              <Route path="/sessions" element={<SessionsList />} />
              <Route path="/sessions/:id" element={<div>Session Detail Page</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

const mockSessions = [
  {
    id: "sess_1",
    title: "Alpha Session",
    agent: { id: "agent_1", version: 1 },
    environment_id: "env_1",
    status: "idle",
    created_at: new Date("2026-01-01T00:00:00Z").toISOString(),
  },
  {
    id: "sess_2",
    title: null,
    agent: { id: "agent_1", version: 1 },
    environment_id: "env_1",
    status: "running",
    created_at: new Date("2026-01-02T00:00:00Z").toISOString(),
  },
];

const mockAgents = [
  { id: "agent_1", name: "Agent One" },
];

const mockEnvs = [
  { id: "env_1", name: "Env One" },
];

function setupBaseHandlers(sessions = mockSessions) {
  server.use(
    http.get("/v1/sessions", () => {
      return HttpResponse.json({ data: sessions });
    }),
    http.get("/v1/agents", () => {
      return HttpResponse.json({ data: mockAgents });
    }),
    http.get("/v1/agents/:id", () => {
      return HttpResponse.json({ mcp_servers: [] });
    }),
    http.get("/v1/environments", () => {
      return HttpResponse.json({ data: mockEnvs });
    }),
    http.get("/v1/vaults", () => {
      return HttpResponse.json({ data: [] });
    }),
    http.get("/v1/files", () => {
      return HttpResponse.json({ data: [] });
    }),
    http.get("/v1/memory_stores", () => {
      return HttpResponse.json({ data: [] });
    }),
  );
}

describe("SessionsList UX: session naming and rename actions", () => {
  beforeEach(() => {
    setupBaseHandlers();
  });

  it("labels the name field as 'Name (optional)' with conversation placeholder in New Session dialog", async () => {
    const user = userEvent.setup();
    let createdPayload: unknown = null;

    server.use(
      http.post("/v1/sessions", async ({ request }) => {
        createdPayload = await request.json();
        return HttpResponse.json({
          id: "sess_new",
          title: (createdPayload as any)?.title ?? null,
          agent: { id: "agent_1", version: 1 },
          environment_id: "env_1",
          status: "idle",
          created_at: new Date().toISOString(),
        });
      }),
    );

    renderSessionsList();

    // Open New Session modal
    const newSessionButton = await screen.findByRole("button", { name: "+ New session" });
    await user.click(newSessionButton);

    // Verify label is "Name (optional)" and NOT "Title (optional)"
    expect(screen.queryByLabelText(/Title \(optional\)/i)).not.toBeInTheDocument();
    const nameInput = screen.getByLabelText(/Name \(optional\)/i);
    expect(nameInput).toBeInTheDocument();
    expect(nameInput).toHaveAttribute("id", "session-name");
    expect(nameInput).toHaveAttribute("name", "oma-session-title");
    expect(nameInput).toHaveAttribute("autoComplete", "off");
    expect(nameInput).toHaveAttribute("placeholder", "My conversation");

    // Fill in Name and submit
    await user.type(nameInput, "Sprint Planning");
    const createButton = screen.getByRole("button", { name: "Create" });
    await user.click(createButton);

    await waitFor(() => {
      expect(createdPayload).toMatchObject({
        title: "Sprint Planning",
      });
    });
  });

  it("renders a Rename row action in the actions menu for each session", async () => {
    const user = userEvent.setup();
    renderSessionsList();

    // Wait for sessions to load
    expect(await screen.findByText("Alpha Session")).toBeInTheDocument();
    expect(screen.getByText("Untitled")).toBeInTheDocument();

    // Open action menu for Alpha Session
    const actionMenuButton = screen.getByRole("button", { name: "Actions for Alpha Session" });
    await user.click(actionMenuButton);

    // Verify Rename action is present
    const renameMenuItem = await screen.findByRole("menuitem", { name: /Rename/i });
    expect(renameMenuItem).toBeInTheDocument();
  });

  it("opens an accessible rename dialog, trims whitespace, and persists via POST /v1/sessions/:id", async () => {
    const user = userEvent.setup();
    let updatePayload: unknown = null;
    let updateRequested = false;

    server.use(
      http.post("/v1/sessions/sess_1", async ({ request }) => {
        updateRequested = true;
        updatePayload = await request.json();
        return HttpResponse.json({
          id: "sess_1",
          title: (updatePayload as any)?.title,
          agent: { id: "agent_1", version: 1 },
          environment_id: "env_1",
          status: "idle",
          created_at: new Date("2026-01-01T00:00:00Z").toISOString(),
        });
      }),
    );

    renderSessionsList();

    expect(await screen.findByText("Alpha Session")).toBeInTheDocument();

    // Open action menu and click Rename
    const actionMenuButton = screen.getByRole("button", { name: "Actions for Alpha Session" });
    await user.click(actionMenuButton);

    const renameMenuItem = await screen.findByRole("menuitem", { name: /Rename/i });
    await user.click(renameMenuItem);

    // Modal dialog should appear
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Rename/i)).toBeInTheDocument();

    const nameInput = within(dialog).getByRole("textbox", { name: /Name/i });
    expect(nameInput).toHaveValue("Alpha Session");

    // Clear and enter new name with surrounding whitespace
    await user.clear(nameInput);
    await user.type(nameInput, "   Refactored Architecture Review   ");

    const saveButton = within(dialog).getByRole("button", { name: /Save|Rename/i });
    await user.click(saveButton);

    await waitFor(() => {
      expect(updateRequested).toBe(true);
      expect(updatePayload).toEqual({
        title: "Refactored Architecture Review",
      });
    });

    // Dialog should close
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("deliberately handles blank rename by submitting empty string (clearing to Untitled)", async () => {
    const user = userEvent.setup();
    let updatePayload: unknown = null;
    let updateRequested = false;

    server.use(
      http.post("/v1/sessions/sess_1", async ({ request }) => {
        updateRequested = true;
        updatePayload = await request.json();
        return HttpResponse.json({
          id: "sess_1",
          title: "",
          agent: { id: "agent_1", version: 1 },
          environment_id: "env_1",
          status: "idle",
          created_at: new Date("2026-01-01T00:00:00Z").toISOString(),
        });
      }),
    );

    renderSessionsList();

    expect(await screen.findByText("Alpha Session")).toBeInTheDocument();

    // Open action menu and click Rename
    const actionMenuButton = screen.getByRole("button", { name: "Actions for Alpha Session" });
    await user.click(actionMenuButton);

    const renameMenuItem = await screen.findByRole("menuitem", { name: /Rename/i });
    await user.click(renameMenuItem);

    const dialog = await screen.findByRole("dialog");
    const nameInput = within(dialog).getByRole("textbox", { name: /Name/i });

    // Clear and type only whitespace
    await user.clear(nameInput);
    await user.type(nameInput, "     ");

    const saveButton = within(dialog).getByRole("button", { name: /Save|Rename/i });
    await user.click(saveButton);

    await waitFor(() => {
      expect(updateRequested).toBe(true);
      expect(updatePayload).toEqual({
        title: "",
      });
    });
  });

  it("makes no network request when rename is cancelled", async () => {
    const user = userEvent.setup();
    let updateRequested = false;

    server.use(
      http.post("/v1/sessions/sess_1", async () => {
        updateRequested = true;
        return HttpResponse.json({});
      }),
    );

    renderSessionsList();

    expect(await screen.findByText("Alpha Session")).toBeInTheDocument();

    const actionMenuButton = screen.getByRole("button", { name: "Actions for Alpha Session" });
    await user.click(actionMenuButton);

    const renameMenuItem = await screen.findByRole("menuitem", { name: /Rename/i });
    await user.click(renameMenuItem);

    const dialog = await screen.findByRole("dialog");
    const nameInput = within(dialog).getByRole("textbox", { name: /Name/i });
    await user.type(nameInput, " Changed My Mind");

    const cancelButton = within(dialog).getByRole("button", { name: /Cancel/i });
    await user.click(cancelButton);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    expect(updateRequested).toBe(false);
  });

  it("handles update failures without crashing and leaves the dialog open for retry", async () => {
    const user = userEvent.setup();

    server.use(
      http.post("/v1/sessions/sess_1", () => {
        return HttpResponse.json(
          { error: { type: "server_error", message: "Database failure" } },
          { status: 500 },
        );
      }),
    );

    renderSessionsList();

    expect(await screen.findByText("Alpha Session")).toBeInTheDocument();

    const actionMenuButton = screen.getByRole("button", { name: "Actions for Alpha Session" });
    await user.click(actionMenuButton);

    const renameMenuItem = await screen.findByRole("menuitem", { name: /Rename/i });
    await user.click(renameMenuItem);

    const dialog = await screen.findByRole("dialog");
    const nameInput = within(dialog).getByRole("textbox", { name: /Name/i });
    await user.clear(nameInput);
    await user.type(nameInput, "New Name");

    const saveButton = within(dialog).getByRole("button", { name: /Save|Rename/i });
    await user.click(saveButton);

    // Dialog stays open so user can retry or cancel
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(saveButton).not.toBeDisabled();
  });

  it("prevents duplicate update requests when submitted while a rename is already in-flight", async () => {
    const user = userEvent.setup();
    let postCount = 0;
    let resolvePost: () => void = () => {};

    server.use(
      http.post("/v1/sessions/sess_1", async () => {
        postCount += 1;
        await new Promise<void>((resolve) => {
          resolvePost = resolve;
        });
        return HttpResponse.json({
          id: "sess_1",
          title: "First In Flight Title",
          agent: { id: "agent_1", version: 1 },
          environment_id: "env_1",
          status: "idle",
          created_at: new Date("2026-01-01T00:00:00Z").toISOString(),
        });
      }),
    );

    renderSessionsList();

    expect(await screen.findByText("Alpha Session")).toBeInTheDocument();

    const actionMenuButton = screen.getByRole("button", { name: "Actions for Alpha Session" });
    await user.click(actionMenuButton);

    const renameMenuItem = await screen.findByRole("menuitem", { name: /Rename/i });
    await user.click(renameMenuItem);

    const dialog = await screen.findByRole("dialog");
    const nameInput = within(dialog).getByRole("textbox", { name: /Name/i });
    await user.clear(nameInput);
    await user.type(nameInput, "First In Flight Title");

    // First submission via Save button
    const form = dialog.querySelector("form")!;
    const saveButton = within(dialog).getByRole("button", { name: /Save|Rename/i });
    await user.click(saveButton);

    // Verify first request was initiated
    await waitFor(() => {
      expect(postCount).toBe(1);
    });

    // Attempt second submission while in-flight (via Enter key / form submit)
    fireEvent.submit(form);
    await user.click(saveButton);

    // Verify postCount remains 1
    expect(postCount).toBe(1);

    // Resolve in-flight request
    resolvePost?.();

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
