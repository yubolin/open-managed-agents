import { Navigate, type RouteObject } from "react-router";
import { AppShell } from "./components/AppShell";
import { CatalogPage } from "./pages/CatalogPage";
import { RunsPage } from "./pages/RunsPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { ApprovalsPage } from "./pages/ApprovalsPage";

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/catalog" replace /> },
      { path: "catalog", element: <CatalogPage /> },
      { path: "runs", element: <RunsPage /> },
      { path: "runs/:id", element: <RunDetailPage /> },
      { path: "approvals", element: <ApprovalsPage /> },
      { path: "*", element: <Navigate to="/catalog" replace /> },
    ],
  },
];
