/**
 * ============================================================================
 * FULL-SYSTEM SHOWCASE
 * ============================================================================
 *
 * Runs every demo scenario end to end and prints the complete picture: the
 * orchestration pipeline, all seven agents, their rationales, the orchestrator's
 * conflict arbitration, escalations, the persisted records, the customer's
 * inbox, and the executive dashboards.
 *
 * Doubles as the frontend brief: every block below is a screen or a component
 * the UI needs, and every value shown is available over the REST API.
 *
 *   npx tsx scripts/showcase.mts            # every scenario
 *   npx tsx scripts/showcase.mts primary    # just the primary demo
 */
import { AGENT_IDS, type AgentId } from '../src/domain/agent.schema';
import type { ReturnCase } from '../src/domain/case-state.schema';
import { db, resetDb } from '../src/repositories/db';
import { env } from '../src/config/env';
import { runPipeline } from '../src/orchestrator/orchestrator';
import { resetStore } from '../src/orchestrator/state-store';
import { describePipeline } from '../src/orchestrator/pipeline.config';
import { implementationFor, listAgents } from '../src/agents/base/registry';
import * as analytics from '../src/services/analytics.service';

/* ------------------------------- formatting ------------------------------- */

const W = 100;
const rule = (ch = '─') => console.log(ch.repeat(W));
const banner = (title: string) => {
  console.log('\n' + '━'.repeat(W));
  console.log(`  ${title}`);
  console.log('━'.repeat(W));
};
const section = (title: string) => {
  console.log(`\n┌─ ${title} ${'─'.repeat(Math.max(0, W - title.length - 4))}`);
};
const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `$${n.toFixed(2)}`);
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
const wrap = (text: string, indent = 4, width = W - 6): string[] => {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if ((line + word).length > width) {
      out.push(' '.repeat(indent) + line.trim());
      line = '';
    }
    line += `${word} `;
  }
  if (line.trim()) out.push(' '.repeat(indent) + line.trim());
  return out;
};

const STATUS_ICON: Record<string, string> = {
  COMPLETED: '✔',
  COMPLETED_WITH_WARNINGS: '▲',
  ESCALATED: '⇈',
  SKIPPED: '⊘',
  FAILED: '✖',
  RUNNING: '…',
  PENDING: '·',
};

/* ============================================================================ */
/* Header                                                                       */
/* ============================================================================ */

function printHeader() {
  console.log('╔' + '═'.repeat(W - 2) + '╗');
  console.log('║' + '  COSMIC RETURN NAVIGATOR — FULL BACKEND SHOWCASE'.padEnd(W - 2) + '║');
  console.log('║' + '  Orchestration Engine + 7 specialized agents'.padEnd(W - 2) + '║');
  console.log('╚' + '═'.repeat(W - 2) + '╝');

  section('RUNTIME CONFIGURATION');
  const agents = listAgents();
  const llm = agents.filter((a) => a.implementation === 'llm');
  console.log(`  agent runtime      : ${env.AGENT_RUNTIME}`);
  console.log(`  model              : ${env.LLM_MODEL}   effort=${env.LLM_EFFORT}  maxTurns=${env.LLM_MAX_TURNS}`);
  console.log(`  endpoint           : ${env.ANTHROPIC_BASE_URL ?? 'api.anthropic.com (default)'}`);
  console.log(`  auth mode          : ${env.authMode}`);
  console.log(`  model-backed agents: ${llm.length}/7  ${llm.map((a) => a.agentId).join(', ') || '(none)'}`);
  console.log(`  rules fallback     : ${env.LLM_FALLBACK_TO_RULES ? 'enabled' : 'disabled'}`);
  console.log(`  clock              : ${env.DEMO_FREEZE_CLOCK ? `FROZEN @ ${env.DEMO_NOW}` : 'system time'}`);

  section('AGENT REGISTRY  →  frontend: agent panel cards  (GET /api/v1/agents)');
  for (const a of agents) {
    console.log(`  stage ${a.stage}  ${pad(a.agentId, 15)} ${pad(a.implementation.toUpperCase(), 6)} ${a.name}`);
    for (const l of wrap(a.purpose, 12, W - 14)) console.log(l);
  }

  section('ORCHESTRATION PLAN  →  frontend: pipeline diagram  (GET /api/v1/meta/pipeline)');
  for (const s of describePipeline().stages) {
    const mode = s.agents.length > 1 ? `${s.mode} (${s.agents.length} concurrent)` : s.mode;
    console.log(`  ${s.stage}. ${pad(s.name, 22)} ${pad(mode, 26)} ${s.agents.join(' ‖ ') || `[${s.owner}]`}`);
  }
  console.log(`\n  Conflict arbitration runs between stages 4 and 5 (cost vs carbon).`);
}

/* ============================================================================ */
/* Per-case report                                                              */
/* ============================================================================ */

function printCase(scenarioName: string, c: ReturnCase, elapsedMs: number) {
  banner(`SCENARIO: ${scenarioName}`);

  console.log(`\n  customer says: "${c.rawInput}"`);
  console.log(`\n  case ${c.caseId}   status ${c.status}   stages ${c.currentStage}/${c.totalStages}   wall ${(elapsedMs / 1000).toFixed(1)}s`);

  /* ---- stage 0: intent parsing ---- */
  if (c.intent) {
    section('STAGE 0 · INTENT NORMALIZATION  →  frontend: "we understood" chips');
    console.log(`  reason          : ${c.intent.reason}   fault=${c.intent.faultAttribution}   condition=${c.intent.reportedCondition}`);
    console.log(`  requested       : ${c.intent.requestedOutcome}   qty=${c.intent.quantity}`);
    console.log(`  resolved entity : ${c.intent.customerId} / ${c.intent.orderId} / ${c.intent.sku}`);
    console.log(`  parse confidence: ${(c.intent.parseConfidence * 100).toFixed(0)}%`);
    if (c.intent.extractedEntities.length) {
      console.log(`  extracted       : ${c.intent.extractedEntities.map((e) => `${e.type}="${e.sourceText}"`).join('  ')}`);
    }
  }

  /* ---- context ---- */
  if (c.context) {
    const ctx = c.context;
    section('SHARED STATE · hydrated once, read by all 7 agents');
    console.log(`  customer : ${ctx.customer.firstName} ${ctx.customer.lastName} · ${ctx.customer.loyaltyTier} · LTV ${money(ctx.customer.lifetimeValueUsd)} · ${ctx.customer.tenureMonths}mo · NPS ${ctx.customer.lastNpsScore ?? '—'}`);
    console.log(`  product  : ${ctx.product.name} · ${ctx.product.sku} · ${money(ctx.product.priceUsd)} · ${ctx.product.category}`);
    console.log(`  order    : ${ctx.order.orderId} · delivered ${ctx.order.deliveredAt?.slice(0, 10)} · scan=${ctx.order.deliveryCondition}`);
    console.log(`  policy   : effective window ${ctx.policy.effectiveReturnWindowDays}d = ${ctx.policy.windowDerivation.filter((d) => d.applied).map((d) => `${d.days}d ${d.source}`).join(' + ')}`);
    console.log(`  logistics: ${ctx.logisticsCatalog.carriers.length} carriers · ${ctx.logisticsCatalog.dropOffLocations.length} drop-offs · consolidation=${ctx.logisticsCatalog.consolidationBatchAvailable}`);
    console.log(`  inventory: ${ctx.inventory.availableUnits} new · ${ctx.inventory.refurbishedUnits} refurbished`);
  }

  /* ---- agent runs ---- */
  section('AGENT EXECUTION  →  frontend: live pipeline with per-agent cards (SSE /stream)');
  console.log(`  ${pad('AGENT', 15)} ${pad('IMPL', 6)} ${pad('STATUS', 24)} ${pad('MS', 7)} CONF  HEADLINE`);
  rule('·');
  for (const run of [...c.agentRuns].sort((a, b) => a.stage - b.stage || a.agentId.localeCompare(b.agentId))) {
    const icon = STATUS_ICON[run.status] ?? '?';
    console.log(
      `  ${pad(run.agentId, 15)} ${pad(run.implementation, 6)} ${icon} ${pad(run.status, 22)} ${pad(String(run.durationMs), 7)} ${
        run.confidence !== null ? run.confidence.toFixed(2) : ' —  '
      }  ${pad(run.headline ?? '', 34)}`,
    );
  }

  /* ---- rationales: the explainability requirement ---- */
  section('AGENT RATIONALES  →  frontend: "how we decided" drill-down panel');
  for (const agentId of AGENT_IDS) {
    const r = c.agentResults[agentId];
    if (!r) continue;
    console.log(`\n  ▸ ${agentId.toUpperCase()} (${r.implementation})`);
    for (const l of wrap(r.rationale, 6)) console.log(l);
    for (const w of r.warnings) {
      for (const l of wrap(`⚠ [${w.code}] ${w.message}`, 6)) console.log(l);
    }
  }

  /* ---- selected agent detail ---- */
  const el = c.agentResults.eligibility?.output;
  if (el) {
    section('ELIGIBILITY RULE TRACE  →  frontend: expandable policy audit table');
    console.log(`  decision ${el.decision}   score ${el.eligibilityScore}/100   fee ${money(el.restockingFeeUsd)}   refundable ${money(el.refundableAmountUsd)}`);
    console.log(`  ${pad('RULE', 28)} ${pad('OUTCOME', 16)} DETAIL`);
    rule('·');
    for (const r of el.ruleTrace) {
      console.log(`  ${pad(r.ruleId, 28)} ${pad(r.outcome + (r.waivedBy ? ` (${r.waivedBy})` : ''), 16)} ${pad(r.detail, W - 50)}`);
    }
  }

  const sent = c.agentResults.sentiment?.output;
  if (sent) {
    section('SENTIMENT & RETENTION  →  frontend: churn gauge + emotion chips + goodwill budget');
    console.log(`  sentiment  : ${sent.sentiment.label} (${sent.sentiment.score})  intensity ${sent.sentiment.intensity}`);
    console.log(`  emotions   : ${sent.sentiment.emotions.map((e) => `${e.emotion}:${e.intensity.toFixed(2)}`).join('  ')}`);
    if (sent.sentiment.drivers.length) {
      console.log(`  driven by  : ${sent.sentiment.drivers.slice(0, 6).map((d) => `"${d.term}"`).join(', ')}`);
    }
    console.log(`  severity   : ${sent.complaintSeverity}   urgency ${sent.urgency}   tone → ${sent.recommendedTone}`);
    console.log(`  value band : ${sent.customerValue.valueBand}   revenue at risk ${money(sent.customerValue.revenueAtRiskUsd)}`);
    console.log(`  churn risk : ${sent.churnRisk.score}/100 (${sent.churnRisk.band})  p=${sent.churnRisk.churnProbability}`);
    for (const d of sent.churnRisk.drivers) {
      console.log(`      ${pad(d.factor, 20)} +${String(d.contribution).padStart(5)}  ${pad(d.detail, W - 40)}`);
    }
    console.log(`  goodwill   : budget ${money(sent.retention.maxGoodwillBudgetUsd)}  warranted=${sent.retention.warranted}  satisfactionBoost=${sent.retention.satisfactionWeightBoost}`);
    for (const g of sent.retention.recommendedGestures) {
      console.log(`      ▪ ${g.type} ${g.value} ${g.unit} (cost ${money(g.estimatedCostUsd)}, −${g.expectedChurnReduction} churn)`);
    }
  }

  const res = c.agentResults.resolution?.output;
  if (res) {
    section('RESOLUTION DECISION MATRIX  →  frontend: the money shot, a scored comparison table');
    console.log(
      `  weights: satisfaction ${res.weights.satisfaction} · cost ${res.weights.cost} · retention ${res.weights.retention} · sustainability ${res.weights.sustainability}`,
    );
    if (res.weights.adjustmentReason) for (const l of wrap(res.weights.adjustmentReason, 4)) console.log(l);
    console.log(`\n  ${pad('OPTION', 18)} ${pad('SAT', 5)}${pad('COST', 6)}${pad('RET', 5)}${pad('SUS', 5)}${pad('SCORE', 7)}${pad('$', 10)} VERDICT`);
    rule('·');
    for (const row of res.decisionMatrix) {
      const mark = row.selected ? '►' : row.feasible ? ' ' : '✗';
      console.log(
        `  ${mark}${pad(row.type, 17)} ${pad(String(row.satisfactionScore), 5)}${pad(String(row.costScore), 6)}${pad(String(row.retentionScore), 5)}${pad(String(row.sustainabilityScore), 5)}${pad(String(row.weightedScore), 7)}${pad(money(row.estimatedCostUsd), 10)} ${pad(row.verdict, W - 68)}`,
      );
    }
    console.log(`\n  cost breakdown: refund ${money(res.costs.refundUsd)} · goods ${money(res.costs.replacementGoodsCostUsd)} · reverse ship ${money(res.costs.reverseShippingUsd)} · goodwill ${money(res.costs.goodwillUsd)} · recovered −${money(res.costs.recoveredValueUsd)}`);
    console.log(`  NET COST ${money(res.costs.netCostUsd)}   retained value ${money(res.estimatedRetainedValueUsd)}   ROI ${res.retentionRoi ?? '—'}x`);
    console.log(`  gates: returnShipment=${res.requiresReturnShipment}  outbound=${res.requiresOutboundShipment}  humanApproval=${res.requiresHumanApproval}  SLA ${res.slaHours}h`);
    for (const g of res.goodwill) console.log(`  granted: ${g.type} ${g.value} ${g.unit} (cost ${money(g.costUsd)})`);
  }

  const log = c.agentResults.logistics?.output;
  if (log) {
    section('REVERSE LOGISTICS  →  frontend: carrier comparison + label + pickup card');
    if (!log.required) {
      console.log(`  ⊘ no shipment required — ${log.skipReason}`);
    } else {
      console.log(`  carrier screening:`);
      for (const v of log.carriersEvaluated) {
        console.log(`      ${v.eligible ? '✔' : '✗'} ${pad(v.carrierName, 22)} ${pad(v.reason, W - 34)}`);
      }
      console.log(`\n  ${pad('OPTION', 12)} ${pad('CARRIER', 20)} ${pad('METHOD', 17)}${pad('COST', 9)}${pad('DAYS', 6)}${pad('CO2kg', 8)}${pad('CONV', 6)} SUS`);
      rule('·');
      for (const o of log.candidateOptions) {
        const mark = o.optionId === log.finalSelectionId ? '►' : o.optionId === log.provisionalSelectionId ? '∙' : ' ';
        console.log(
          `  ${mark}${pad(o.optionId, 11)} ${pad(o.carrierName, 20)} ${pad(o.method, 17)}${pad(money(o.costUsd), 9)}${pad(String(o.totalDaysToResolution), 6)}${pad(String(o.estimatedCo2Kg), 8)}${pad(String(o.convenienceScore), 6)} ${o.sustainabilityScore ?? '—'}`,
        );
      }
      console.log(`\n  strategy   : ${log.selectionBasis?.strategy}`);
      if (log.selectionBasis) for (const l of wrap(log.selectionBasis.reason, 6)) console.log(l);
      console.log(`  provisional: ${log.provisionalSelectionId}   FINAL: ${log.finalSelectionId}  (∙ = agent pick, ► = orchestrator's final)`);
      if (log.label) console.log(`  label      : ${log.label.labelId} · ${log.label.trackingNumber} · ${log.label.format} · printing=${log.label.requiresPrinting}`);
      if (log.pickup) console.log(`  pickup     : ${log.pickup.scheduledDate} 09:00-13:00 · consolidated=${log.pickup.isConsolidated} · code ${log.pickup.confirmationCode}`);
      if (log.trackingEvents.length) {
        console.log(`  tracking timeline (frontend: vertical stepper):`);
        for (const e of log.trackingEvents) {
          console.log(`      ${e.isProjected ? '○' : '●'} ${pad(e.status, 18)} ${e.occurredAt.slice(0, 16)}  ${pad(e.description, W - 46)}`);
        }
      }
    }
  }

  const sus = c.agentResults.sustainability?.output;
  if (sus) {
    section('SUSTAINABILITY LEDGER  →  frontend: CO2 breakdown chart + green badge');
    console.log(`  footprint ${sus.footprintKg}kg  vs baseline ${sus.baselineKg}kg (${sus.baselineBasis})`);
    console.log(`  ⇒ CO2 PREVENTED ${sus.co2PreventedKg}kg   grade ${sus.grade}   score ${sus.sustainabilityScore}/100`);
    console.log(`  breakdown: transport ${sus.breakdown.transportKg} · packaging ${sus.breakdown.packagingKg} · processing ${sus.breakdown.processingKg} · disposition ${sus.breakdown.dispositionKg} · avoided manufacture ${sus.breakdown.avoidedManufactureKg}`);
    console.log(`  equivalents: ${sus.equivalents.carKmAvoided}km driving · ${sus.equivalents.treeDaysOfAbsorption} tree-days`);
    console.log(`  disposition: ${sus.disposition.path} (circularity ${sus.disposition.circularityScore}/100, recovered ${money(sus.disposition.recoveredValueUsd)})`);
    console.log(`  packaging  : ${sus.packaging.instructions}`);
    console.log(`  greener available=${sus.greenerAlternativeAvailable}  verdict ${sus.tradeoff.verdict}`);
    for (const l of wrap(sus.tradeoff.reason, 6)) console.log(l);
    if (sus.incentive) for (const l of wrap(`incentive: ${sus.incentive.customerFacingCopy}`, 6)) console.log(l);
  }

  const ins = c.agentResults.insights?.output;
  if (ins) {
    section('BUSINESS INTELLIGENCE  →  frontend: insight cards for product/policy/ops');
    console.log(`  signals detected: ${ins.caseSignals.length}   insights promoted: ${ins.insights.length}`);
    for (const s of ins.caseSignals) {
      console.log(`      ▪ ${pad(s.signalType, 28)} strength ${s.strength.toFixed(2)}`);
      for (const l of wrap(s.note, 10)) console.log(l);
    }
    if (ins.suppressedReason) for (const l of wrap(`suppressed: ${ins.suppressedReason}`, 6)) console.log(l);
    for (const i of ins.insights) {
      console.log(`\n      ★ [${i.severity}] ${i.title}`);
      for (const l of wrap(i.summary, 10)) console.log(l);
      console.log(`        owner ${i.owningTeam} · priority ${i.priorityScore} · annual impact ${money(i.estimatedAnnualImpactUsd ?? 0)}`);
      for (const a of i.recommendedActions) {
        for (const l of wrap(`→ ${a.description} [${a.owningTeam}, effort ${a.effort}]`, 10)) console.log(l);
        for (const l of wrap(`  success metric: ${a.successMetric}`, 10)) console.log(l);
      }
    }
    console.log(`\n  KPI contribution: TAT ${ins.kpiContribution.turnaroundHours}h · cost ${money(ins.kpiContribution.costUsd ?? 0)} · automated=${ins.kpiContribution.fullyAutomated} · deflected=${ins.kpiContribution.ticketDeflected}`);
  }

  /* ---- orchestrator arbitration ---- */
  if (c.conflicts.length) {
    section("ORCHESTRATOR CONFLICT ARBITRATION  →  frontend: 'how we arbitrated' panel");
    for (const cf of c.conflicts) {
      console.log(`\n  ⚔ ${cf.type}  parties: ${cf.parties.join(' vs ')}`);
      for (const l of wrap(cf.description, 6)) console.log(l);
      for (const p of cf.positions) {
        for (const l of wrap(`${p.agentId} wants: ${p.position}`, 8)) console.log(l);
      }
      for (const l of wrap(`RESOLVED → ${cf.resolution}`, 6)) console.log(l);
      console.log(`      policy: ${cf.resolutionPolicy}`);
      console.log(`      trade-off accepted: ${JSON.stringify(cf.tradeoffAccepted)}`);
    }
  }

  /* ---- escalations ---- */
  if (c.escalations.length) {
    section('ESCALATIONS  →  frontend: support console queue');
    for (const e of c.escalations) {
      console.log(`  ${e.blocking ? '🛑 BLOCKING' : '· advisory '} [${e.severity}] ${pad(e.code, 30)} → ${e.suggestedQueue} (p${e.priority})`);
      for (const l of wrap(e.reason, 6)) console.log(l);
    }
  }

  /* ---- notifications ---- */
  const comm = c.agentResults.communication?.output;
  if (comm) {
    section('CUSTOMER COMMUNICATIONS  →  frontend: inbox preview + notification schedule');
    console.log(`  channel plan: primary ${comm.channelPlan.primary}  fallbacks [${comm.channelPlan.fallbacks.join(', ')}]  tone ${comm.toneUsed}`);
    if (comm.toneOverrideReason) for (const l of wrap(`tone override: ${comm.toneOverrideReason}`, 6)) console.log(l);
    for (const m of comm.messages) {
      console.log(`\n  ┌─ ${m.channel} · ${m.trigger} · ${m.tone}`);
      if (m.subject) console.log(`  │ SUBJECT: ${m.subject}`);
      for (const bodyLine of m.body.split('\n')) {
        for (const l of wrap(bodyLine || ' ', 4, W - 8)) console.log(`  │${l.slice(2)}`);
      }
      console.log(`  └─`);
    }
    console.log(`\n  scheduled follow-ups (${comm.scheduled.length}):`);
    for (const s of comm.scheduled) {
      console.log(`      ${pad(s.trigger, 24)} ${s.scheduledFor.slice(0, 16)} via ${pad(s.channel, 8)} ${pad(s.description, W - 60)}`);
    }
    if (comm.humanHandoff?.required) {
      console.log(`\n  HUMAN HANDOFF → ${comm.humanHandoff.queue} (priority ${comm.humanHandoff.priority}, SLA ${comm.humanHandoff.slaMinutes}min)`);
      for (const l of wrap(comm.humanHandoff.briefing, 6)) console.log(l);
      for (const f of comm.humanHandoff.keyFacts) for (const l of wrap(`• ${f}`, 6)) console.log(l);
      if (comm.humanHandoff.suggestedOpeningLine) {
        for (const l of wrap(`opening line: "${comm.humanHandoff.suggestedOpeningLine}"`, 6)) console.log(l);
      }
    }
  }

  /* ---- final outcome ---- */
  if (c.finalOutcome) {
    const o = c.finalOutcome;
    section('FINAL OUTCOME  →  frontend: the hero result card');
    console.log('\n  ╭' + '─'.repeat(W - 6) + '╮');
    for (const l of wrap(o.customerMessage, 4, W - 12)) console.log(`  │${l.slice(2).padEnd(W - 8)}│`);
    console.log('  ╰' + '─'.repeat(W - 6) + '╯');
    console.log(`\n  resolution ${o.resolutionType}   refund ${money(o.refundAmountUsd)}   points ${o.pointsAwarded ?? '—'}   cost ${money(o.totalCostUsd)}`);
    console.log(`  method ${o.returnMethod ?? '—'}   pickup ${o.pickupScheduledFor?.slice(0, 16) ?? '—'}   tracking ${o.trackingNumber ?? '—'}`);
    console.log(`  CO2 prevented ${o.co2PreventedKg ?? '—'}kg (grade ${o.sustainabilityGrade ?? '—'})   fully automated: ${o.fullyAutomated}`);
    console.log(`\n  next steps for the customer:`);
    for (const s of o.nextSteps) for (const l of wrap(`☐ ${s}`, 6)) console.log(l);
  }

  /* ---- persisted records ---- */
  section('PERSISTED RECORDS  →  proves the data model is exercised end to end');
  console.log(`  Return          ${c.returnId ?? '—'}`);
  console.log(`  Resolution      ${c.resolutionId ?? '—'}`);
  console.log(`  Shipment        ${c.shipmentId ?? '—'}`);
  console.log(`  Sustainability  ${c.sustainabilityRecordId ?? '—'}`);
  console.log(`  Notifications   ${c.notificationIds.length} → ${c.notificationIds.join(', ') || '—'}`);
  console.log(`  Insights        ${c.insightIds.length} → ${c.insightIds.join(', ') || '—'}`);

  /* ---- trace ---- */
  section(`EXECUTION TRACE (${c.trace.length} events)  →  frontend: audit timeline`);
  for (const e of c.trace) {
    console.log(`  ${String(e.sequence).padStart(3)} ${pad(e.type, 20)} ${pad(e.agentId ?? '—', 15)} ${pad(e.message, W - 48)}`);
  }
}

/* ============================================================================ */
/* Cross-case dashboards                                                        */
/* ============================================================================ */

function printDashboards(results: { name: string; c: ReturnCase; ms: number }[]) {
  banner('CROSS-SCENARIO SUMMARY  →  frontend: support console case list');
  console.log(`  ${pad('SCENARIO', 32)} ${pad('STATUS', 22)} ${pad('RESOLUTION', 17)}${pad('COST', 9)}${pad('CO2', 8)}${pad('ESC', 5)} AUTO`);
  rule('·');
  for (const { name, c } of results) {
    const o = c.finalOutcome;
    console.log(
      `  ${pad(name, 32)} ${pad(c.status, 22)} ${pad(o?.resolutionType ?? '—', 17)}${pad(money(o?.totalCostUsd), 9)}${pad(
        o?.co2PreventedKg !== null && o?.co2PreventedKg !== undefined ? `${o.co2PreventedKg}kg` : '—',
        8,
      )}${pad(String(c.escalations.length), 5)} ${o?.fullyAutomated ? 'yes' : 'no'}`,
    );
  }

  banner('EXECUTIVE KPI DASHBOARD  →  frontend: exec screen (GET /api/v1/analytics/kpis)');
  const k = analytics.getKpiSnapshot(30);
  const kpi = (label: string, value: string, delta?: number) =>
    console.log(`  ${pad(label, 34)} ${value.padStart(14)}${delta !== undefined ? `   ${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)}` : ''}`);
  kpi('Total returns (30d)', String(k.totalReturns));
  kpi('Return rate', `${k.returnRatePct}%`, k.deltas.returnRatePct);
  kpi('Avg turnaround', `${k.avgTurnaroundHours}h`, k.deltas.avgTurnaroundHours);
  kpi('Automation rate', `${k.automationRatePct}%`, k.deltas.automationRatePct);
  kpi('Ticket deflection', `${k.ticketDeflectionPct}%`, k.deltas.ticketDeflectionPct);
  kpi('Avg cost per return', money(k.avgCostPerReturnUsd), k.deltas.avgCostPerReturnUsd);
  kpi('Retained revenue', money(k.retainedRevenueUsd));
  kpi('CSAT / NPS', `${k.avgCsat} / ${k.nps}`, k.deltas.nps);
  kpi('CO2 prevented', `${k.co2PreventedKg}kg`, k.deltas.co2PreventedKg);
  kpi('Sustainable return share', `${k.sustainableReturnPct}%`, k.deltas.sustainableReturnPct);
  kpi('Escalation rate', `${k.escalationRatePct}%`);
  kpi('Insights generated / actioned', `${k.insightsGenerated} / ${k.insightsActioned}`);

  banner('SUSTAINABILITY DASHBOARD  →  frontend: sustainability lead screen');
  const s = analytics.getSustainabilitySummary();
  console.log(`  total CO2 prevented   ${s.totalCo2PreventedKg}kg   (this session: ${s.liveCo2PreventedKg}kg)`);
  console.log(`  packaging waste saved ${s.packagingWasteAvoidedKg}kg`);
  console.log(`  recovered value       ${money(s.recoveredValueUsd)}`);
  console.log(`  avg circularity       ${s.avgCircularityScore ?? '—'}/100`);
  console.log(`  records               ${s.recordCount}   grades ${JSON.stringify(s.byGrade)}`);
  console.log(`  dispositions          ${JSON.stringify(s.byDisposition)}`);
  console.log(`  no greener option      ${s.noGreenerOptionCount} case(s)   green declined ${s.greenOptionDeclinedCount}`);
  console.log(`  equivalents           ${s.equivalents.carKmAvoided}km driving · ${s.equivalents.treesPlantedEquivalent} trees`);

  banner('ROOT CAUSES  →  frontend: exec "what to fix" ranked list');
  console.log(`  ${pad('PATTERN', 32)} ${pad('INSIGHTS', 10)}${pad('OBSERVED', 10)}${pad('ANNUAL $', 12)} OWNER`);
  rule('·');
  for (const rc of analytics.getRootCauses()) {
    console.log(`  ${pad(rc.type, 32)} ${pad(String(rc.insightCount), 10)}${pad(String(rc.observationCount), 10)}${pad(money(rc.estimatedAnnualImpactUsd), 12)} ${rc.owningTeam}`);
  }

  banner('INSIGHT BOARD  →  frontend: product/policy backlog');
  for (const i of db.insights.all().sort((a, b) => b.priorityScore - a.priorityScore)) {
    console.log(`  [${pad(i.severity, 8)}] p${String(i.priorityScore).padStart(3)} ${pad(i.status, 14)} ${pad(i.title, W - 40)}`);
    console.log(`             owner ${pad(i.owningTeam, 22)} observed ${i.observationCount}x   impact ${money(i.estimatedAnnualImpactUsd ?? 0)}`);
  }

  banner('CUSTOMER INBOX  →  frontend: notification centre');
  for (const n of db.notifications.all()) {
    console.log(`  ${pad(n.channel, 8)} ${pad(n.trigger, 22)} ${pad(n.tone, 20)} ${pad(n.subject ?? n.body.slice(0, 50), W - 56)}`);
  }

  banner('API SURFACE  →  everything above is reachable over REST');
  console.log('  61 endpoints. Full machine-readable manifest: GET /api/v1/meta/routes');
  console.log('  Live agent status for the animated pipeline: GET /api/v1/returns/cases/:caseId/stream (SSE)');
}

/* ============================================================================ */
/* Main                                                                         */
/* ============================================================================ */

async function main() {
  const onlyPrimary = process.argv.includes('primary');

  resetDb();
  resetStore();
  printHeader();

  const scenarios = db.scenarios
    .all()
    .filter((s) => !onlyPrimary || s.isPrimary)
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));

  const results: { name: string; c: ReturnCase; ms: number }[] = [];

  for (const scenario of scenarios) {
    const startMs = Date.now();
    const c = await runPipeline(scenario.input, {
      customerId: scenario.customerId,
      orderId: scenario.orderId,
      orderItemId: scenario.orderItemId,
      scenarioId: scenario.scenarioId,
    });
    const ms = Date.now() - startMs;
    printCase(`${scenario.name}  [${scenario.personaLabel}]`, c, ms);
    results.push({ name: scenario.name, c, ms });
  }

  printDashboards(results);

  /* --- run accounting --- */
  banner('RUN ACCOUNTING');
  const llmRuns = results.flatMap(({ c }) =>
    AGENT_IDS.map((id) => c.agentResults[id]).filter((r) => r?.implementation === 'llm'),
  );
  const fellBack = results.flatMap(({ c }) =>
    AGENT_IDS.map((id) => c.agentResults[id]).filter((r) =>
      r?.warnings.some((w) => w.code.startsWith('LLM_') && w.code.endsWith('FALLBACK')),
    ),
  );
  const cost = llmRuns.reduce((sum, r) => {
    const tag = r?.inputsUsed.find((i) => i.startsWith('cost:$'));
    return sum + (tag ? Number.parseFloat(tag.replace('cost:$', '')) : 0);
  }, 0);

  console.log(`  scenarios run       : ${results.length}`);
  console.log(`  agent invocations   : ${results.length * AGENT_IDS.length}`);
  console.log(`  served by the model : ${llmRuns.length}`);
  console.log(`  fell back to rules  : ${fellBack.length}`);
  console.log(`  estimated model cost: ${money(cost)}`);
  console.log(`  total wall clock    : ${(results.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(1)}s`);
  console.log(`  agents per case      : ${AGENT_IDS.length} across 6 stages, 2 of them parallel`);
  rule('━');
}

main().catch((err) => {
  console.error('\nSHOWCASE FAILED:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack.split('\n').slice(1, 6).join('\n'));
  process.exit(1);
});
