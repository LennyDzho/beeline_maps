"use client";

import { useEffect, useState } from "react";
import MaterialIcon from "@/app/components/material-icon";
import { apiRequest } from "@/app/lib/api-client";
import type { OrganizationOption } from "@/auth/organization-context";

export default function OrganizationSwitcher() {
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    apiRequest<{ organizations: OrganizationOption[]; currentOrganizationId: string }>("/api/organization-context")
      .then((data) => {
        if (!active) return;
        setOrganizations(data.organizations);
        setSelectedId(data.currentOrganizationId);
      })
      .catch((reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, []);

  async function selectOrganization(organizationId: string) {
    const previousId = selectedId;
    setSelectedId(organizationId);
    setBusy(true);
    setError("");
    try {
      await apiRequest("/api/organization-context", { method: "PUT", body: JSON.stringify({ organizationId }) });
      window.location.reload();
    } catch (reason) {
      setSelectedId(previousId);
      setBusy(false);
      setError(reason instanceof Error ? reason.message : "Не удалось сменить организацию.");
    }
  }

  return (
    <label className="dispatcher-organization-select">
      <MaterialIcon name="corporate_fare" />
      <span className="sr-only">Организация</span>
      <select value={selectedId} disabled={busy || !organizations.length} onChange={(event) => void selectOrganization(event.target.value)}>
        {!organizations.length && <option value="">Загрузка организаций…</option>}
        {organizations.map((organization) => <option value={organization.id} key={organization.id}>{organization.name}</option>)}
      </select>
      {busy && <MaterialIcon name="progress_activity" />}
      {error && <small role="status">{error}</small>}
    </label>
  );
}
