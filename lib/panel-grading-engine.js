import { performance } from 'perf_hooks';
import { gradeSubmission } from './grading-engine.js';
import { gradeSubmissionWithCli, arbitrateGradesWithCodex } from './cli-grading-engine.js';
import { MODELS } from './gemini.js';

const GEMINI_INITIAL_MODEL = 'gemini-3.5-flash';
const AGY_INITIAL_MODEL = 'agy-gemini-3.1-pro-high';
const ARBITRATOR_MODEL = 'codex-gpt-5.5-xhigh';

function nowIso() {
  return new Date().toISOString();
}

function compactGrade(grade) {
  return {
    student_id: grade?.student_id,
    student_name: grade?.student_name,
    total_score: grade?.total_score,
    overall_comment: grade?.overall_comment,
    needs_review_count: (grade?.questions || []).filter(q => q.needs_review).length,
    questions: (grade?.questions || []).map(q => ({
      question_id: q.question_id,
      max_score: q.max_score,
      awarded_score: q.awarded_score,
      is_correct: q.is_correct,
      needs_review: q.needs_review,
      error_description: q.error_description,
      reasoning: q.reasoning,
    })),
  };
}

async function runTimedInitial({ modelKey, label, run, onStage }) {
  const startedAt = nowIso();
  const t0 = performance.now();
  onStage?.({ phase: 'initial_start', model_key: modelKey, model_label: label });
  try {
    const grade = await run();
    const elapsedMs = Math.round(performance.now() - t0);
    onStage?.({ phase: 'initial_done', model_key: modelKey, model_label: label, elapsed_ms: elapsedMs, score: grade.total_score });
    return {
      ok: true,
      model_key: modelKey,
      model_label: label,
      elapsed_ms: elapsedMs,
      started_at: startedAt,
      finished_at: nowIso(),
      grade,
    };
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - t0);
    onStage?.({ phase: 'initial_error', model_key: modelKey, model_label: label, elapsed_ms: elapsedMs, error: err.message || String(err) });
    return {
      ok: false,
      model_key: modelKey,
      model_label: label,
      elapsed_ms: elapsedMs,
      started_at: startedAt,
      finished_at: nowIso(),
      error: err?.stack || err?.message || String(err),
    };
  }
}

function questionMap(grade) {
  return new Map((grade?.questions || []).map(q => [q.question_id, q]));
}

function buildDisagreements(geminiGrade, agyGrade, finalGrade) {
  const gemini = questionMap(geminiGrade);
  const agy = questionMap(agyGrade);
  const final = questionMap(finalGrade);
  const qids = Array.from(new Set([
    ...gemini.keys(),
    ...agy.keys(),
    ...final.keys(),
  ])).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

  return qids.map(questionId => {
    const g = gemini.get(questionId);
    const a = agy.get(questionId);
    const f = final.get(questionId);
    const geminiScore = typeof g?.awarded_score === 'number' ? g.awarded_score : null;
    const agyScore = typeof a?.awarded_score === 'number' ? a.awarded_score : null;
    const finalScore = typeof f?.awarded_score === 'number' ? f.awarded_score : null;
    const numeric = [geminiScore, agyScore].filter(v => typeof v === 'number');
    const spread = numeric.length >= 2 ? Math.abs(geminiScore - agyScore) : null;
    return {
      question_id: questionId,
      max_score: f?.max_score ?? g?.max_score ?? a?.max_score ?? null,
      gemini_score: geminiScore,
      agy_score: agyScore,
      final_score: finalScore,
      spread,
      needs_review: Boolean(f?.needs_review) || (spread !== null && spread >= 3),
      gemini_reasoning: g?.reasoning || '',
      agy_reasoning: a?.reasoning || '',
      final_reasoning: f?.reasoning || '',
    };
  }).sort((a, b) => (b.spread ?? -1) - (a.spread ?? -1));
}

export const PANEL_WORKFLOW = {
  gemini_initial: GEMINI_INITIAL_MODEL,
  agy_initial: AGY_INITIAL_MODEL,
  arbitrator: ARBITRATOR_MODEL,
};

export async function gradeSubmissionWithPanel(pdfPath, assignment = 'default', options = {}) {
  const onStage = options.onStage;
  const expectedStudent = options.expectedStudent || {};
  const panelStartedAt = nowIso();
  const panelT0 = performance.now();

  onStage?.({ phase: 'panel_start', model_label: 'Gemini 3.5 Flash + AGY Gemini 3.1 Pro High -> Codex GPT-5.5 xhigh' });

  const [geminiInitial, agyInitial] = await Promise.all([
    runTimedInitial({
      modelKey: GEMINI_INITIAL_MODEL,
      label: MODELS[GEMINI_INITIAL_MODEL]?.label || GEMINI_INITIAL_MODEL,
      onStage,
      run: () => gradeSubmission(pdfPath, assignment, GEMINI_INITIAL_MODEL, { onRetry: options.onRetry }),
    }),
    runTimedInitial({
      modelKey: AGY_INITIAL_MODEL,
      label: MODELS[AGY_INITIAL_MODEL]?.label || AGY_INITIAL_MODEL,
      onStage,
      run: () => gradeSubmissionWithCli(pdfPath, assignment, AGY_INITIAL_MODEL, { onRetry: options.onRetry }),
    }),
  ]);

  const failures = [geminiInitial, agyInitial].filter(r => !r.ok);
  if (failures.length > 0) {
    const details = failures.map(f => f.model_label + ': ' + String(f.error || '').split('\n')[0]).join(' | ');
    const err = new Error('并行初评失败：' + details);
    err.panel_results = { geminiInitial, agyInitial };
    throw err;
  }

  onStage?.({ phase: 'arbitration_start', model_key: ARBITRATOR_MODEL, model_label: MODELS[ARBITRATOR_MODEL]?.label || ARBITRATOR_MODEL });
  const arbitrationStartedAt = nowIso();
  const arbitrationT0 = performance.now();
  const finalGrade = await arbitrateGradesWithCodex(pdfPath, assignment, {
    gemini: geminiInitial.grade,
    agy: agyInitial.grade,
  }, { expectedStudent });
  const arbitrationElapsedMs = Math.round(performance.now() - arbitrationT0);

  if (expectedStudent.student_id) finalGrade.student_id = expectedStudent.student_id;
  if (expectedStudent.student_name) finalGrade.student_name = expectedStudent.student_name;

  const disagreements = buildDisagreements(geminiInitial.grade, agyInitial.grade, finalGrade);
  const panelElapsedMs = Math.round(performance.now() - panelT0);
  finalGrade.grading_panel = {
    workflow: 'parallel_initial_then_codex_arbitration',
    started_at: panelStartedAt,
    finished_at: nowIso(),
    elapsed_ms: panelElapsedMs,
    initial: {
      gemini: {
        model_key: geminiInitial.model_key,
        model_label: geminiInitial.model_label,
        elapsed_ms: geminiInitial.elapsed_ms,
        started_at: geminiInitial.started_at,
        finished_at: geminiInitial.finished_at,
        grade: compactGrade(geminiInitial.grade),
      },
      agy: {
        model_key: agyInitial.model_key,
        model_label: agyInitial.model_label,
        elapsed_ms: agyInitial.elapsed_ms,
        started_at: agyInitial.started_at,
        finished_at: agyInitial.finished_at,
        grade: compactGrade(agyInitial.grade),
      },
    },
    arbitrator: {
      model_key: ARBITRATOR_MODEL,
      model_label: MODELS[ARBITRATOR_MODEL]?.label || ARBITRATOR_MODEL,
      elapsed_ms: arbitrationElapsedMs,
      started_at: arbitrationStartedAt,
      finished_at: nowIso(),
    },
    disagreements,
  };

  onStage?.({ phase: 'arbitration_done', model_key: ARBITRATOR_MODEL, model_label: MODELS[ARBITRATOR_MODEL]?.label || ARBITRATOR_MODEL, elapsed_ms: arbitrationElapsedMs, score: finalGrade.total_score });
  onStage?.({ phase: 'panel_done', elapsed_ms: panelElapsedMs, score: finalGrade.total_score });
  return finalGrade;
}
