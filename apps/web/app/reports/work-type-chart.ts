import type { ReportGroup } from "./report-data";

const COLORS = ["#6750a4", "#ce9c28", "#258577", "#4779b7", "#ba507d", "#df7739", "#849238", "#926ca6"];

export function buildWorkTypeChart(groups: readonly ReportGroup[]) {
  const positive = groups.filter((group) => Number.isFinite(group.count) && group.count > 0);
  const total = positive.reduce((sum, group) => sum + group.count, 0);
  let cumulative = 0;
  const slices = positive.map((group, index) => {
    const start = cumulative / total * 100;
    cumulative += group.count;
    // Use full precision for geometry; round only the displayed percentage.
    const end = index === positive.length - 1 ? 100 : cumulative / total * 100;
    const color = COLORS[index] ?? `hsl(${(index * 137.508) % 360} 48% 46%)`;
    return { ...group, color, start, end, percentage: group.count / total * 100 };
  });
  const background = slices.length
    ? `conic-gradient(${slices.map((slice) => `${slice.color} ${slice.start}% ${slice.end}%`).join(", ")})`
    : "var(--st-outline-soft)";
  return { total, slices, background };
}
