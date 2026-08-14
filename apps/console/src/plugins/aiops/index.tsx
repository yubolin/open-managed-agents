// AIOps console plugin — the enterprise closed-loop views
// (docs/aiops-closed-loop.md): alert list + approval queue.
//
// Deliberately built on the plugin extension point (plugins/registry.ts)
// instead of editing main.tsx / AppSidebar.tsx / i18n: the whole AIOps UI
// lives in new files, and wiring it in is a one-line registry change —
// the same upgrade-isolation rule the backend follows (§升级隔离).
// Pages self-contain their data fetching per the plugin contract.
//
// Note: hosted builds that overlay-replace plugins/registry.ts must keep
// this import (the enterprise privatization line owns its own build, so
// the default registry below registers it unconditionally).
import { ShieldCheckIcon, SirenIcon } from "lucide-react";
import type { ConsolePlugin } from "../registry";
import { AlertsPage } from "./AlertsPage";
import { ApprovalsPage } from "./ApprovalsPage";

export const aiopsPlugin: ConsolePlugin = {
  id: "aiops",
  routes: [
    { path: "aiops/alerts", element: <AlertsPage /> },
    { path: "aiops/approvals", element: <ApprovalsPage /> },
  ],
  navGroups: [
    {
      label: "AIOps",
      items: [
        { to: "/aiops/alerts", label: "Alerts", icon: SirenIcon },
        { to: "/aiops/approvals", label: "Approvals", icon: ShieldCheckIcon },
      ],
    },
  ],
};
