import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { Terminal, Layers, CheckSquare, ListOrdered, User } from "lucide-react";
import { cn } from "../lib/utils";

export function AppShell() {
  const location = useLocation();
  const [tenant, setTenant] = useState(() => localStorage.getItem("openma_tenant_id") || "tenant_default");

  const handleTenantChange = (newTenant: string) => {
    setTenant(newTenant);
    localStorage.setItem("openma_tenant_id", newTenant);
    window.location.reload();
  };

  const navItems = [
    { to: "/catalog", label: "服务目录", icon: Layers },
    { to: "/runs", label: "工单看板", icon: ListOrdered },
    { to: "/approvals", label: "审批中心", icon: CheckSquare },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100 selection:bg-emerald-500/20 selection:text-emerald-300">
      {/* Top Header */}
      <header className="sticky top-0 z-50 glass-panel border-b border-slate-800/80 px-4 sm:px-8 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          {/* Logo & Workspace Title */}
          <div className="flex items-center gap-6">
            <NavLink to="/catalog" className="flex items-center gap-2.5 group">
              <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 group-hover:border-emerald-500/60 transition-colors glow-emerald">
                <Terminal className="w-4 h-4" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-sm tracking-tight text-slate-100 font-mono">OpenMA</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-950/80 border border-emerald-800 text-emerald-400 font-mono font-medium">
                    Operations
                  </span>
                </div>
                <div className="text-[10px] text-slate-400 font-sans">企业级自主运维工作台</div>
              </div>
            </NavLink>

            {/* Navigation Tabs */}
            <nav className="hidden md:flex items-center gap-1 bg-slate-900/60 p-1 rounded-xl border border-slate-800">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = location.pathname.startsWith(item.to);
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={cn(
                      "flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all",
                      isActive
                        ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shadow-xs"
                        : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
                    )}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{item.label}</span>
                  </NavLink>
                );
              })}
            </nav>
          </div>

          {/* Right Utilities */}
          <div className="flex items-center gap-3">
            {/* Live SSE Indicator */}
            <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-950/40 border border-emerald-800/40 text-[11px] text-emerald-400">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              <span className="font-mono">StreamHub Live</span>
            </div>

            {/* Tenant Selector */}
            <div className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-900 border border-slate-800 rounded-lg text-xs">
              <span className="text-slate-500">租户:</span>
              <select
                value={tenant}
                onChange={(e) => handleTenantChange(e.target.value)}
                className="bg-transparent text-slate-200 font-mono text-xs focus:outline-none cursor-pointer"
              >
                <option value="tenant_default" className="bg-slate-900">tenant_default</option>
                <option value="tenant_bayer" className="bg-slate-900">tenant_bayer</option>
                <option value="tenant_prod" className="bg-slate-900">tenant_prod</option>
              </select>
            </div>

            {/* Current User Pill */}
            <div className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-300">
              <div className="w-5 h-5 rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center">
                <User className="w-3 h-3" />
              </div>
              <span className="font-mono text-xs">Operator (Bob)</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Outlet */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-8">
        <Outlet />
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 py-4 px-8 text-center text-xs text-slate-600 font-mono">
        OpenMA Operations Workspace · SLA ≤2s Event Broadcast · SoD & Dual-Hash CAS Protected
      </footer>
    </div>
  );
}
