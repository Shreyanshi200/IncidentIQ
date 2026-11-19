import PDFDocument from "pdfkit";
import type { DashboardIncidentDetail, DashboardTimelineEvent } from "./dashboard.service.js";

const COLORS = {
  navy: "#081b2c",
  ink: "#142338",
  muted: "#65758b",
  faint: "#d9e3ec",
  paper: "#f6f9fb",
  accent: "#11889b",
  accentDark: "#0b6675",
  accentSoft: "#e7f6f8",
  warning: "#a56808",
  warningSoft: "#fff6df",
  danger: "#bd3f50",
  dangerSoft: "#fff0f2",
  white: "#ffffff"
};

const MARGINS = { top: 46, right: 42, bottom: 58, left: 42 };

interface ReportLayout {
  document: PDFKit.PDFDocument;
  pageSections: string[];
  activeSection: string;
}

function printable(value: string): string {
  return value.replace(/[\u2010-\u2015]/g, "-");
}

function label(value: string): string {
  return printable(value.replaceAll("_", " "));
}

function sentenceCase(value: string): string {
  const text = label(value);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function factorTitle(value: string): string {
  switch (value) {
    case "temporal_proximity": return "Failure followed the suspected change";
    case "entity_match": return "Same service and environment";
    case "version_match": return "Same deployed version";
    case "propagation_order": return "Dependency failed first";
    case "resource_signal": return "Direct workload failure";
    case "route_specificity": return "A specific request path failed";
    case "counterevidence": return "Failure existed before the change";
    default: return sentenceCase(value);
  }
}

function formatTimestamp(value: string, includeDate = true): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return printable(value);
  const options: Intl.DateTimeFormatOptions = includeDate
    ? { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" };
  return `${new Intl.DateTimeFormat("en-US", options).format(date)} UTC`;
}

function compactValue(value: unknown): string {
  if (typeof value === "string") return printable(value);
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return printable(JSON.stringify(value));
}

function eventAttribute(event: DashboardTimelineEvent, name: string): string | undefined {
  const value = event.attributes[name];
  return typeof value === "string" && value.trim() ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
}

export function describeReportEvent(event: DashboardTimelineEvent): string {
  if (event.event_type === "deployment") {
    const state = eventAttribute(event, "deployment_status") ?? eventAttribute(event, "state") ?? "recorded";
    const commit = eventAttribute(event, "commit_sha") ?? eventAttribute(event, "commit");
    const ref = eventAttribute(event, "ref");
    return `Deployment ${state}${event.version ? ` for version ${event.version}` : ""}${ref ? ` from ${ref}` : ""}${commit ? ` at commit ${commit.slice(0, 12)}` : ""}.`;
  }
  if (event.source === "node_sdk" && (event.severity === "error" || event.severity === "critical")) {
    const route = eventAttribute(event, "route") ?? event.resource?.replace(/^route\//, "");
    const message = eventAttribute(event, "message") ?? sentenceCase(event.event_type);
    const status = eventAttribute(event, "status_code");
    return `${message}${route ? ` on ${route}` : ""}${status ? ` returned HTTP ${status}` : ""}.`;
  }
  if (event.source === "kubernetes") {
    const ready = eventAttribute(event, "ready_replicas");
    const desired = eventAttribute(event, "desired_replicas");
    if (event.event_type === "deployment_recovered") {
      return `${event.resource ?? event.service} recovered${event.version ? ` on version ${event.version}` : ""}${ready && desired ? ` with ${ready} of ${desired} replicas ready` : ""}.`;
    }
    const reason = eventAttribute(event, "reason") ?? eventAttribute(event, "message");
    const restarts = eventAttribute(event, "restarts") ?? eventAttribute(event, "restart_count");
    return `Kubernetes recorded ${label(event.event_type)} for ${event.resource ?? event.service}${restarts ? ` after ${restarts} restart${restarts === "1" ? "" : "s"}` : ""}${reason ? `: ${reason}` : ""}.`;
  }
  if (event.source === "alertmanager") {
    const alert = eventAttribute(event, "alertname") ?? sentenceCase(event.event_type);
    const state = eventAttribute(event, "status") ?? eventAttribute(event, "state") ?? event.severity;
    const value = eventAttribute(event, "current_value") ?? eventAttribute(event, "value");
    const threshold = eventAttribute(event, "threshold");
    return `${alert} ${state}${value ? ` at ${value}` : ""}${threshold ? `; configured threshold is ${threshold}` : ""}.`;
  }
  if (event.event_type === "health_check" || event.event_type === "service_state") {
    const state = eventAttribute(event, "status") ?? sentenceCase(event.event_type);
    const ready = eventAttribute(event, "ready_replicas");
    const desired = eventAttribute(event, "desired_replicas");
    const alerts = eventAttribute(event, "open_alerts");
    return `${event.service} reported ${state}${ready && desired ? ` with ${ready} of ${desired} replicas ready` : ""}${alerts ? ` and ${alerts} open alerts` : ""}.`;
  }
  return `${sentenceCase(event.source)} recorded ${label(event.event_type)} for ${event.service}.`;
}

function evidenceObservation(event: DashboardTimelineEvent): string {
  return `${formatTimestamp(event.occurred_at, false)} - ${describeReportEvent(event)}`;
}

function contentWidth(document: PDFKit.PDFDocument): number {
  return document.page.width - document.page.margins.left - document.page.margins.right;
}

function pill(document: PDFKit.PDFDocument, text: string, x: number, y: number, background: string, foreground: string, width?: number): number {
  const pillWidth = width ?? Math.max(54, document.font("Helvetica-Bold").fontSize(7.5).widthOfString(text) + 20);
  document.roundedRect(x, y, pillWidth, 22, 11).fill(background);
  document.font("Helvetica-Bold").fontSize(7.5).fillColor(foreground).text(printable(text), x, y + 7, { width: pillWidth, align: "center", lineBreak: false });
  return pillWidth;
}

function runningHeader(layout: ReportLayout): void {
  const { document } = layout;
  const left = document.page.margins.left;
  const width = contentWidth(document);
  document.rect(0, 0, document.page.width, 6).fill(COLORS.accent);
  document.font("Helvetica-Bold").fontSize(8.5).fillColor(COLORS.accentDark).text("INCIDENTIQ", left, 28, { characterSpacing: 1.4, lineBreak: false });
  document.font("Helvetica").fontSize(8).fillColor(COLORS.muted).text(layout.activeSection.toUpperCase(), left, 45, { characterSpacing: 0.8, lineBreak: false });
  document.font("Helvetica-Bold").fontSize(7.5).fillColor(COLORS.accent).text("BACK TO SUMMARY", left + width - 110, 31, { width: 110, align: "right", goTo: "summary", lineBreak: false });
  document.moveTo(left, 62).lineTo(left + width, 62).lineWidth(0.7).strokeColor(COLORS.faint).stroke();
  document.x = left;
  document.y = 82;
}

function startPage(layout: ReportLayout, section: string): void {
  layout.document.addPage();
  layout.activeSection = section;
  layout.pageSections.push(section);
  runningHeader(layout);
}

function ensureSpace(layout: ReportLayout, height: number): void {
  const { document } = layout;
  if (document.y + height > document.page.height - document.page.margins.bottom - 8) startPage(layout, layout.activeSection);
}

function sectionStart(layout: ReportLayout, title: string, subtitle: string, destination: string): void {
  startPage(layout, title);
  const { document } = layout;
  const left = document.page.margins.left;
  const width = contentWidth(document);
  document.addNamedDestination(destination);
  document.outline.addItem(title);
  document.font("Helvetica-Bold").fontSize(23).fillColor(COLORS.ink).text(printable(title), left, document.y, { width });
  document.moveDown(0.35);
  document.font("Helvetica").fontSize(9.5).fillColor(COLORS.muted).text(printable(subtitle), left, document.y, { width, lineGap: 2 });
  document.moveDown(1.15);
}

function metricCard(document: PDFKit.PDFDocument, x: number, y: number, width: number, title: string, value: string, accent = COLORS.accent): void {
  document.roundedRect(x, y, width, 67, 7).lineWidth(0.7).fillAndStroke(COLORS.white, COLORS.faint);
  document.rect(x, y, 4, 67).fill(accent);
  document.font("Helvetica").fontSize(7.5).fillColor(COLORS.muted).text(title.toUpperCase(), x + 14, y + 13, { width: width - 24, characterSpacing: 0.7, lineBreak: false });
  document.font("Helvetica-Bold").fontSize(13).fillColor(COLORS.ink).text(printable(value), x + 14, y + 35, { width: width - 24, ellipsis: true, lineBreak: false });
}

function drawCover(layout: ReportLayout, incident: DashboardIncidentDetail): void {
  const { document } = layout;
  const left = document.page.margins.left;
  const width = contentWidth(document);
  const sources = new Set(incident.timeline.map((event) => event.source));

  document.addNamedDestination("summary");
  document.outline.addItem("Executive summary", { expanded: true });
  document.rect(0, 0, document.page.width, 190).fill(COLORS.navy);
  document.rect(0, 0, 8, 190).fill(COLORS.accent);
  document.font("Helvetica-Bold").fontSize(10).fillColor("#65d9e6").text("INCIDENTIQ", left, 36, { characterSpacing: 1.8, lineBreak: false });
  document.font("Helvetica").fontSize(8).fillColor("#9db2c8").text("EVIDENCE-FIRST INCIDENT REPORT", left, 54, { characterSpacing: 1, lineBreak: false });
  document.font("Helvetica-Bold").fontSize(28).fillColor(COLORS.white).text(printable(incident.service), left, 88, { width: width - 150, ellipsis: true, lineBreak: false });
  document.font("Helvetica").fontSize(11).fillColor("#b7c8d8").text(printable(incident.environment), left, 130, { width: width - 170, ellipsis: true, lineBreak: false });
  pill(document, `${incident.confidence.toUpperCase()} CONFIDENCE`, left + width - 132, 92, "#123c45", "#77e2c1", 132);
  pill(document, `${incident.state.toUpperCase()} INCIDENT`, left + width - 132, 124, "#342c3d", "#ffb7c2", 132);
  document.font("Helvetica").fontSize(7.5).fillColor("#8fa6bb").text(`REPORT ID  ${printable(incident.incident_id)}`, left, 165, { width, ellipsis: true, lineBreak: false });

  const metricY = 214;
  const gap = 9;
  const metricWidth = (width - gap * 3) / 4;
  metricCard(document, left, metricY, metricWidth, "Leading cause", sentenceCase(incident.leading_cause));
  metricCard(document, left + metricWidth + gap, metricY, metricWidth, "Linked evidence", String(incident.event_count));
  metricCard(document, left + (metricWidth + gap) * 2, metricY, metricWidth, "Evidence sources", String(sources.size));
  metricCard(document, left + (metricWidth + gap) * 3, metricY, metricWidth, "Latest state", sentenceCase(incident.state), incident.state === "open" ? COLORS.danger : COLORS.accent);

  document.font("Helvetica").fontSize(7.5).fillColor(COLORS.muted).text(`OPENED  ${formatTimestamp(incident.started_at)}`, left, 294, { width: width / 2, lineBreak: false });
  document.text(`LATEST EVIDENCE  ${formatTimestamp(incident.last_event_at)}`, left + width / 2, 294, { width: width / 2, align: "right", lineBreak: false });

  const summaryY = 324;
  const summaryHeight = document.font("Helvetica").fontSize(10).heightOfString(printable(incident.brief.summary), { width: width - 36, lineGap: 3 });
  const summaryCardHeight = Math.max(102, summaryHeight + 62);
  document.roundedRect(left, summaryY, width, summaryCardHeight, 8).fill(COLORS.accentSoft);
  document.font("Helvetica-Bold").fontSize(7.5).fillColor(COLORS.accentDark).text("LEADING HYPOTHESIS", left + 18, summaryY + 16, { characterSpacing: 0.9, lineBreak: false });
  document.font("Helvetica-Bold").fontSize(15).fillColor(COLORS.ink).text(printable(incident.brief.headline), left + 18, summaryY + 34, { width: width - 36 });
  document.moveDown(0.35);
  document.font("Helvetica").fontSize(10).fillColor(COLORS.ink).text(printable(incident.brief.summary), left + 18, document.y, { width: width - 36, lineGap: 3 });

  const scopeY = summaryY + summaryCardHeight + 14;
  document.roundedRect(left, scopeY, width, 62, 8).fill(COLORS.paper);
  document.font("Helvetica-Bold").fontSize(7.5).fillColor(COLORS.muted).text("OBSERVED SCOPE", left + 18, scopeY + 14, { characterSpacing: 0.8, lineBreak: false });
  document.font("Helvetica").fontSize(9).fillColor(COLORS.ink).text(printable(incident.brief.observed_scope), left + 18, scopeY + 31, { width: width - 36, lineGap: 2, height: 24, ellipsis: true });

  const navY = scopeY + 82;
  document.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.ink).text("Navigate this report", left, navY, { lineBreak: false });
  const navCards = [
    { number: "01", title: "Evidence assessment", detail: "Why this hypothesis", destination: "evidence" },
    { number: "02", title: "Validation plan", detail: "What to verify next", destination: "validation" },
    { number: "03", title: "Evidence timeline", detail: "What happened, in order", destination: "timeline" }
  ];
  const navGap = 10;
  const navWidth = (width - navGap * 2) / 3;
  navCards.forEach((item, index) => {
    const x = left + index * (navWidth + navGap);
    const y = navY + 23;
    document.roundedRect(x, y, navWidth, 58, 7).lineWidth(0.7).fillAndStroke(COLORS.white, COLORS.faint);
    document.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.accent).text(item.number, x + 12, y + 12, { lineBreak: false });
    document.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.ink).text(item.title, x + 12, y + 27, { width: navWidth - 24, ellipsis: true, lineBreak: false });
    document.font("Helvetica").fontSize(7.5).fillColor(COLORS.muted).text(item.detail, x + 12, y + 42, { width: navWidth - 24, ellipsis: true, lineBreak: false });
    document.goTo(x, y, navWidth, 58, item.destination);
  });

  const noteY = navY + 98;
  document.roundedRect(left, noteY, width, 40, 6).fill(COLORS.warningSoft);
  document.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.warning).text("IMPORTANT", left + 14, noteY + 12, { width: 62, lineBreak: false });
  document.font("Helvetica").fontSize(8).fillColor(COLORS.ink).text("This report prioritizes evidence for investigation. It does not prove root cause or measure customer impact.", left + 78, noteY + 11, { width: width - 92, lineGap: 2 });
}

function drawCandidateRanking(layout: ReportLayout, incident: DashboardIncidentDetail): void {
  const { document } = layout;
  const left = document.page.margins.left;
  const width = contentWidth(document);
  const candidates = incident.brief.candidates;
  const highestScore = Math.max(1, ...candidates.map((candidate) => candidate.score));
  const height = 42 + candidates.length * 38;
  ensureSpace(layout, height);
  const y = document.y;
  document.roundedRect(left, y, width, height, 8).fill(COLORS.paper);
  document.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.ink).text("Candidate ranking", left + 16, y + 15, { lineBreak: false });
  document.font("Helvetica").fontSize(7.5).fillColor(COLORS.muted).text("Investigation priority, not probability", left + width - 190, y + 17, { width: 174, align: "right", lineBreak: false });
  candidates.forEach((candidate, index) => {
    const rowY = y + 42 + index * 38;
    document.circle(left + 24, rowY + 6, 10).fill(index === 0 ? COLORS.accent : "#dfe8ee");
    document.font("Helvetica-Bold").fontSize(7).fillColor(index === 0 ? COLORS.white : COLORS.muted).text(String(index + 1), left + 19, rowY + 2, { width: 10, align: "center", lineBreak: false });
    document.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.ink).text(sentenceCase(candidate.cause), left + 43, rowY, { width: width - 130, ellipsis: true, lineBreak: false });
    document.font("Helvetica-Bold").fontSize(8).fillColor(index === 0 ? COLORS.accentDark : COLORS.muted).text(`${candidate.score} pts`, left + width - 62, rowY, { width: 46, align: "right", lineBreak: false });
    document.roundedRect(left + 43, rowY + 19, width - 102, 5, 2.5).fill("#dce6eb");
    document.roundedRect(left + 43, rowY + 19, Math.max(2, Math.max(0, candidate.score) / highestScore * (width - 102)), 5, 2.5).fill(index === 0 ? COLORS.accent : "#7ea9b1");
  });
  document.y = y + height + 16;
}

function evidenceCard(layout: ReportLayout, title: string, description: string, score: number, evidenceIds: string[], timeline: DashboardTimelineEvent[], kind: "supporting" | "counter"): void {
  const { document } = layout;
  const left = document.page.margins.left;
  const width = contentWidth(document);
  const background = kind === "supporting" ? COLORS.accentSoft : COLORS.warningSoft;
  const accent = kind === "supporting" ? COLORS.accent : COLORS.warning;
  const descriptionHeight = document.font("Helvetica").fontSize(9).heightOfString(printable(description), { width: width - 36, lineGap: 2 });
  const observations = evidenceIds.flatMap((eventId) => {
    const event = timeline.find((candidate) => candidate.event_id === eventId);
    return event ? [evidenceObservation(event)] : [];
  }).map((observation) => `- ${observation}`).join("\n");
  const observationsHeight = document.font("Helvetica").fontSize(8).heightOfString(printable(observations), { width: width - 36, lineGap: 2 });
  const ids = `Traceability: ${evidenceIds.join(", ")}`;
  const idsHeight = document.font("Helvetica").fontSize(7.2).heightOfString(printable(ids), { width: width - 40, lineGap: 1 });
  const height = Math.max(108, 74 + descriptionHeight + observationsHeight + idsHeight);
  ensureSpace(layout, height + 10);
  const y = document.y;
  document.roundedRect(left, y, width, height, 8).fill(background);
  document.roundedRect(left, y, 6, height, 3).fill(accent);
  document.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.ink).text(factorTitle(title), left + 18, y + 15, { width: width - 105, ellipsis: true, lineBreak: false });
  pill(document, score > 0 ? `+${score} SCORE` : `${score} SCORE`, left + width - 88, y + 11, kind === "supporting" ? "#ccebed" : "#f7dfaa", accent, 74);
  document.font("Helvetica").fontSize(9).fillColor(COLORS.ink).text(printable(description), left + 18, y + 37, { width: width - 36, lineGap: 2 });
  const observationsY = y + 45 + descriptionHeight;
  document.font("Helvetica-Bold").fontSize(7.5).fillColor(accent).text("LINKED OBSERVATIONS", left + 18, observationsY, { characterSpacing: 0.7, lineBreak: false });
  document.font("Helvetica").fontSize(8).fillColor(COLORS.ink).text(printable(observations), left + 18, observationsY + 15, { width: width - 36, lineGap: 2 });
  document.font("Helvetica").fontSize(7.2).fillColor(COLORS.muted).text(printable(ids), left + 18, y + height - idsHeight - 11, { width: width - 36, lineGap: 1 });
  document.y = y + height + 10;
}

function drawEvidenceAssessment(layout: ReportLayout, incident: DashboardIncidentDetail): void {
  sectionStart(layout, "Evidence assessment", "Understand why the leading cause ranked first and what evidence argues against it.", "evidence");
  const { document } = layout;
  const left = document.page.margins.left;
  const width = contentWidth(document);

  const bannerY = document.y;
  document.roundedRect(left, bannerY, width, 78, 8).fill(COLORS.navy);
  document.font("Helvetica-Bold").fontSize(7.5).fillColor("#65d9e6").text("LEADING HYPOTHESIS", left + 18, bannerY + 15, { characterSpacing: 0.9, lineBreak: false });
  document.font("Helvetica-Bold").fontSize(15).fillColor(COLORS.white).text(printable(incident.brief.headline), left + 18, bannerY + 34, { width: width - 170, ellipsis: true, lineBreak: false });
  pill(document, `${incident.confidence.toUpperCase()} CONFIDENCE`, left + width - 146, bannerY + 28, "#123c45", "#77e2c1", 128);
  document.y = bannerY + 94;

  drawCandidateRanking(layout, incident);
  const supportingHeadingY = document.y;
  document.font("Helvetica-Bold").fontSize(13).fillColor(COLORS.ink).text("Supporting evidence", left, supportingHeadingY, { lineBreak: false });
  document.y = supportingHeadingY + 26;
  if (incident.brief.supporting_evidence.length === 0) {
    document.font("Helvetica").fontSize(9).fillColor(COLORS.muted).text("No decisive supporting factor is available yet.", left, document.y, { width });
    document.moveDown(1);
  }
  for (const factor of incident.brief.supporting_evidence) evidenceCard(layout, factor.name, factor.description, factor.score, factor.evidence_ids, incident.timeline, "supporting");

  if (incident.brief.counterevidence.length > 0) {
    ensureSpace(layout, 50);
    const counterHeadingY = document.y + 4;
    document.font("Helvetica-Bold").fontSize(13).fillColor(COLORS.ink).text("Counterevidence", left, counterHeadingY, { lineBreak: false });
    document.y = counterHeadingY + 26;
    for (const factor of incident.brief.counterevidence) evidenceCard(layout, factor.name, factor.description, factor.score, factor.evidence_ids, incident.timeline, "counter");
  }
}

function validationCard(layout: ReportLayout, check: string, index: number): void {
  const { document } = layout;
  const left = document.page.margins.left;
  const width = contentWidth(document);
  const textHeight = document.font("Helvetica").fontSize(10).heightOfString(printable(check), { width: width - 86, lineGap: 3 });
  const height = Math.max(66, textHeight + 34);
  ensureSpace(layout, height + 11);
  const y = document.y;
  document.roundedRect(left, y, width, height, 8).lineWidth(0.7).fillAndStroke(COLORS.white, COLORS.faint);
  document.roundedRect(left, y, 56, height, 8).fill(COLORS.navy);
  document.font("Helvetica-Bold").fontSize(8).fillColor("#65d9e6").text("STEP", left, y + 15, { width: 56, align: "center", characterSpacing: 0.8, lineBreak: false });
  document.font("Helvetica-Bold").fontSize(18).fillColor(COLORS.white).text(String(index + 1).padStart(2, "0"), left, y + 31, { width: 56, align: "center", lineBreak: false });
  document.font("Helvetica").fontSize(10).fillColor(COLORS.ink).text(printable(check), left + 72, y + 17, { width: width - 88, lineGap: 3 });
  document.y = y + height + 11;
}

function distributionPanel(document: PDFKit.PDFDocument, x: number, y: number, width: number, title: string, entries: Array<[string, number]>, total: number): void {
  const height = 50 + entries.length * 24;
  document.roundedRect(x, y, width, height, 8).fill(COLORS.paper);
  document.font("Helvetica-Bold").fontSize(9.5).fillColor(COLORS.ink).text(title, x + 14, y + 14, { width: width - 28, lineBreak: false });
  entries.forEach(([name, count], index) => {
    const rowY = y + 42 + index * 24;
    document.font("Helvetica").fontSize(8).fillColor(COLORS.muted).text(sentenceCase(name), x + 14, rowY, { width: width - 70, ellipsis: true, lineBreak: false });
    document.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.ink).text(String(count), x + width - 42, rowY, { width: 28, align: "right", lineBreak: false });
    document.roundedRect(x + 14, rowY + 13, width - 28, 3, 1.5).fill("#dbe5eb");
    document.roundedRect(x + 14, rowY + 13, Math.max(2, count / Math.max(1, total) * (width - 28)), 3, 1.5).fill(COLORS.accent);
  });
}

function drawValidationPlan(layout: ReportLayout, incident: DashboardIncidentDetail): void {
  sectionStart(layout, "Validation plan", "Use these checks to confirm or falsify the leading hypothesis before taking corrective action.", "validation");
  const { document } = layout;
  const left = document.page.margins.left;
  const width = contentWidth(document);

  const contextY = document.y;
  document.roundedRect(left, contextY, width, 76, 8).fill(COLORS.accentSoft);
  document.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.accentDark).text("INVESTIGATION CONTEXT", left + 16, contextY + 13, { characterSpacing: 0.8, lineBreak: false });
  const context = incident.brief.context ?? incident.brief.observed_scope;
  document.font("Helvetica").fontSize(9).fillColor(COLORS.ink).text(printable(context), left + 16, contextY + 31, { width: width - 32, height: 38, ellipsis: true, lineGap: 2 });
  document.y = contextY + 92;

  incident.next_checks.forEach((check, index) => validationCard(layout, check, index));

  const sourceCounts = new Map<string, number>();
  const severityCounts = new Map<string, number>();
  for (const event of incident.timeline) {
    sourceCounts.set(event.source, (sourceCounts.get(event.source) ?? 0) + 1);
    severityCounts.set(event.severity, (severityCounts.get(event.severity) ?? 0) + 1);
  }
  const sourceEntries = [...sourceCounts.entries()].sort((leftEntry, rightEntry) => rightEntry[1] - leftEntry[1]);
  const severityEntries = [...severityCounts.entries()].sort((leftEntry, rightEntry) => rightEntry[1] - leftEntry[1]);
  const panelHeight = 50 + Math.max(sourceEntries.length, severityEntries.length) * 24;
  ensureSpace(layout, panelHeight + 50);
  const inventoryHeadingY = document.y + 4;
  document.font("Helvetica-Bold").fontSize(13).fillColor(COLORS.ink).text("Evidence inventory", left, inventoryHeadingY, { lineBreak: false });
  document.y = inventoryHeadingY + 26;
  const panelY = document.y;
  const gap = 12;
  const panelWidth = (width - gap) / 2;
  distributionPanel(document, left, panelY, panelWidth, "By source", sourceEntries, incident.timeline.length);
  distributionPanel(document, left + panelWidth + gap, panelY, panelWidth, "By severity", severityEntries, incident.timeline.length);
  document.y = panelY + panelHeight + 16;
}

function severityColor(severity: string): string {
  if (severity === "critical" || severity === "error") return COLORS.danger;
  if (severity === "warning") return COLORS.warning;
  return COLORS.accent;
}

function eventCard(layout: ReportLayout, event: DashboardTimelineEvent, index: number): void {
  const { document } = layout;
  const left = document.page.margins.left;
  const width = contentWidth(document);
  const entries = Object.entries(event.attributes);
  const middle = Math.ceil(entries.length / 2);
  const columns = [entries.slice(0, middle), entries.slice(middle)];
  const columnWidth = (width - 62) / 2;
  const columnText = columns.map((column) => column.map(([name, value]) => `${label(name)}: ${compactValue(value)}`).join("\n") || "No additional attributes");
  const narrative = describeReportEvent(event);
  const narrativeHeight = document.font("Helvetica").fontSize(8.5).heightOfString(printable(narrative), { width: width - 86, lineGap: 2 });
  document.font("Courier").fontSize(7.1);
  const attributeHeight = Math.max(...columnText.map((text) => document.heightOfString(text, { width: columnWidth, lineGap: 2 })));
  const dividerOffset = 60 + narrativeHeight;
  const attributesOffset = dividerOffset + 12;
  const height = Math.max(132, attributesOffset + attributeHeight + 26);
  const usableHeight = document.page.height - document.page.margins.top - document.page.margins.bottom - 30;
  ensureSpace(layout, Math.min(height + 30, usableHeight));
  const y = document.y;
  const accent = severityColor(event.severity);
  document.roundedRect(left, y, width, height, 8).lineWidth(0.6).fillAndStroke(COLORS.paper, COLORS.faint);
  document.roundedRect(left, y, 6, height, 3).fill(accent);
  document.circle(left + 27, y + 24, 13).fill(accent);
  document.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.white).text(String(index + 1).padStart(2, "0"), left + 19, y + 20, { width: 16, align: "center", lineBreak: false });
  document.font("Helvetica-Bold").fontSize(11).fillColor(COLORS.ink).text(sentenceCase(event.event_type), left + 50, y + 15, { width: width - 248, ellipsis: true, lineBreak: false });
  document.font("Helvetica").fontSize(7.5).fillColor(COLORS.muted).text(formatTimestamp(event.occurred_at, false), left + width - 188, y + 17, { width: 172, align: "right", lineBreak: false });

  const context = [sentenceCase(event.source), sentenceCase(event.severity), event.version ? `Version ${event.version}` : undefined, event.resource, event.trace_id ? `Trace ${event.trace_id}` : undefined].filter(Boolean).join("  |  ");
  document.font("Helvetica").fontSize(8).fillColor(COLORS.muted).text(printable(context), left + 50, y + 36, { width: width - 66, ellipsis: true, lineBreak: false });
  document.font("Helvetica").fontSize(8.5).fillColor(COLORS.ink).text(printable(narrative), left + 50, y + 53, { width: width - 66, lineGap: 2 });
  document.moveTo(left + 18, y + dividerOffset).lineTo(left + width - 18, y + dividerOffset).lineWidth(0.5).strokeColor(COLORS.faint).stroke();
  document.font("Courier").fontSize(7.1).fillColor("#3e5168");
  document.text(columnText[0] ?? "", left + 18, y + attributesOffset, { width: columnWidth, lineGap: 2 });
  document.text(columnText[1] ?? "", left + 34 + columnWidth, y + attributesOffset, { width: columnWidth, lineGap: 2 });
  document.font("Helvetica").fontSize(6.8).fillColor(COLORS.muted).text(`EVENT ID  ${printable(event.event_id)}`, left + 18, y + height - 14, { width: width - 36, ellipsis: true, lineBreak: false });
  document.y = y + height + 12;
}

function drawTimeline(layout: ReportLayout, incident: DashboardIncidentDetail): void {
  sectionStart(layout, "Evidence timeline", "Events are ordered by when each source observed them. Every linked attribute remains available for verification.", "timeline");
  const { document } = layout;
  const left = document.page.margins.left;
  const width = contentWidth(document);

  const legendY = document.y;
  document.roundedRect(left, legendY, width, 46, 8).lineWidth(0.7).fillAndStroke(COLORS.white, COLORS.faint);
  document.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.ink).text(`${incident.timeline.length} LINKED EVENTS`, left + 14, legendY + 16, { width: 102, lineBreak: false });
  const legend = [["INFO", COLORS.accent], ["WARNING", COLORS.warning], ["ERROR / CRITICAL", COLORS.danger]] as const;
  let legendX = left + 142;
  for (const [name, color] of legend) {
    document.circle(legendX, legendY + 21, 4).fill(color);
    document.font("Helvetica-Bold").fontSize(7).fillColor(COLORS.muted).text(name, legendX + 9, legendY + 17, { lineBreak: false });
    legendX += name === "ERROR / CRITICAL" ? 0 : name === "WARNING" ? 102 : 75;
  }
  document.y = legendY + 62;

  incident.timeline.forEach((event, index) => eventCard(layout, event, index));
}

function footer(document: PDFKit.PDFDocument, incident: DashboardIncidentDetail, section: string, page: number, total: number): void {
  const left = document.page.margins.left;
  const width = contentWidth(document);
  const y = document.page.height - 38;
  const bottomMargin = document.page.margins.bottom;
  document.page.margins.bottom = 0;
  document.moveTo(left, y - 10).lineTo(left + width, y - 10).lineWidth(0.5).strokeColor(COLORS.faint).stroke();
  document.font("Helvetica-Bold").fontSize(6.8).fillColor(COLORS.accentDark).text("INCIDENTIQ", left, y, { width: 76, characterSpacing: 0.8, lineBreak: false });
  document.font("Helvetica").fontSize(6.8).fillColor(COLORS.muted).text(section, left + 86, y, { width: 220, lineBreak: false });
  document.text(`${printable(incident.incident_id)}  |  ${page} / ${total}`, left + width - 220, y, { width: 220, align: "right", lineBreak: false });
  document.page.margins.bottom = bottomMargin;
}

function writeReport(document: PDFKit.PDFDocument, incident: DashboardIncidentDetail): void {
  const layout: ReportLayout = { document, pageSections: ["Executive summary"], activeSection: "Executive summary" };
  drawCover(layout, incident);
  drawEvidenceAssessment(layout, incident);
  drawValidationPlan(layout, incident);
  drawTimeline(layout, incident);

  const pages = document.bufferedPageRange();
  for (let index = 0; index < pages.count; index += 1) {
    document.switchToPage(pages.start + index);
    footer(document, incident, layout.pageSections[index] ?? "Incident report", index + 1, pages.count);
  }
}

export function createIncidentReportPdf(incident: DashboardIncidentDetail): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size: "A4",
      margins: MARGINS,
      bufferPages: true,
      info: {
        Title: `IncidentIQ report - ${incident.service}`,
        Author: "IncidentIQ",
        Subject: incident.brief.headline,
        Keywords: "incident, evidence, investigation, timeline"
      }
    });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("error", reject);
    document.on("end", () => resolve(Buffer.concat(chunks)));
    writeReport(document, incident);
    document.end();
  });
}
