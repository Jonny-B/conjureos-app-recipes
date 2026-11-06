/**
 * The reasons recipes-db's reportRecipe and reportChef accept, with the labels
 * ConjureOS's own Report dialog uses (src/shell/ui/ReportDialog.tsx and
 * REPORT_CATEGORY_LABELS), in the order it lists them.
 */
export type ReportCategory =
  | "copyright_dmca"
  | "csam"
  | "malware"
  | "illegal"
  | "ip_other"
  | "harassment"
  | "hateful_sexual"
  | "other";

export const REPORT_CATEGORIES: { id: ReportCategory; label: string }[] = [
  { id: "copyright_dmca", label: "Copyright / DMCA" },
  { id: "csam", label: "Child sexual abuse material" },
  { id: "malware", label: "Malware or harmful code" },
  { id: "illegal", label: "Illegal content" },
  { id: "ip_other", label: "Other IP / trademark" },
  { id: "harassment", label: "Harassment or abuse" },
  { id: "hateful_sexual", label: "Hateful or sexual" },
  { id: "other", label: "Something else" },
];

export const REPORT_DETAILS_MAX = 1000;
