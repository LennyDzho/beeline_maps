"use client";

import RequirementCatalogPanel from "./requirement-catalog-panel";
import type { QualificationRecord } from "./qualification-data";

export default function QualificationsPanel(props: { items: QualificationRecord[]; ready: boolean; onSaved: (item: QualificationRecord) => void }) {
  return <RequirementCatalogPanel {...props} kind="qualifications" />;
}
