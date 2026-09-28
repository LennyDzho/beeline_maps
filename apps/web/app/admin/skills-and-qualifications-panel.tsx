"use client";

import RequirementCatalogPanel from "./requirement-catalog-panel";
import QualificationsPanel from "./qualifications-panel";
import type { SkillRecord } from "./skill-data";
import type { QualificationRecord } from "./qualification-data";

export default function SkillsAndQualificationsPanel({ skills, qualifications, skillsReady, qualificationsReady, onSkillSaved, onQualificationSaved }: {
  skills: SkillRecord[];
  qualifications: QualificationRecord[];
  skillsReady: boolean;
  qualificationsReady: boolean;
  onSkillSaved: (item: SkillRecord) => void;
  onQualificationSaved: (item: QualificationRecord) => void;
}) {
  return <div id="admin-requirements-panel" className="admin-requirements-workspace" role="tabpanel" aria-labelledby="admin-requirements-tab">
    <RequirementCatalogPanel kind="skills" items={skills} ready={skillsReady} onSaved={onSkillSaved} />
    <QualificationsPanel items={qualifications} ready={qualificationsReady} onSaved={onQualificationSaved} />
  </div>;
}
