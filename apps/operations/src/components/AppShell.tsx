import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { Terminal, Layers, CheckSquare, ListOrdered, User } from "lucide-react";
import { cn } from "../lib/utils";

export function AppShell() {
  const location = useLocation();
  const [tenant, setTenant] = useState(() => localStorage.getItem("openma_tenant_id") || "tenant_default");

  const [currentUser, setCurrentUser] = useState(() => localStorage.getItem("openma_user_id") || "user_operator_bob");

  const handleTenantChange = (newTenant: string) => {
    setTenant(newTenant);
    localStorage.setItem("openma_tenant_id", newTenant);
    window.location.reload();
  };

  const handleUserChange = (newUser: string) => {
    setCurrentUser(newUser);
    localStorage.setItem("openma_user_id", newUser);
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
            <nav className="hidden md:flex items-center gap-1 pl-4 border-l border-slate-800">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = location.pathname.startsWith(item.to);
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={cn(
                      "flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                      isActive
                        ? "bg-emerald-950/60 border border-emerald-800/60 text-emerald-300 glow-emerald"
                        : "text-slate-400 hover:text-slate-200 hover:bg-slate-900/60"
                    )}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{item.label}</span>
                  </NavLink>
                );
              })}
            </nav>
          </div>

          {/* Right Controls: SSE Live + Tenant + User Persona */}
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
                <option value="tn_3137942b703f4ea903b624e3d1537152" className="bg-slate-900">Bolin's workspace (tn_3137942b...)</option>
                <option value="tenant_default" className="bg-slate-900">tenant_default</option>
                <option value="tenant_bayer" className="bg-slate-900">tenant_bayer</option>
                <option value="tenant_prod" className="bg-slate-900">tenant_prod</option>
              </select>
            </div>

            {/* Interactive User / Persona Switcher */}
            <div className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-900 border border-slate-800 rounded-lg text-xs">
              <div className="w-4 h-4 rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center">
                <User className="w-2.5 h-2.5" />
              </div>
              <span className="text-slate-500">身份:</span>
              <select
                value={currentUser}
                onChange={(e) => handleUserChange(e.target.value)}
                className="bg-transparent text-slate-200 font-mono text-xs focus:outline-none cursor-pointer"
              >
                <option value="user_operator_bob" className="bg-slate-900">Bob (SRE 初审人 · Stage 1)</option>
                <option value="user_security_charlie" className="bg-slate-900">Charlie (安全总监 · Stage 2)</option>
                <option value="user_director_david" className="bg-slate-900">David (平台总监 · Stage 3)</option>
                <option value="user_applicant_alice" className="bg-slate-900">Alice (申请人 · SoD测试)</option>
                <option value="user_admin_bolin" className="bg-slate-900">Bolin (系统管理员)</option>
              </select>
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
