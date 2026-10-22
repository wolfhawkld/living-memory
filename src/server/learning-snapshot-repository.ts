import type { DatabaseSync } from 'node:sqlite';
import type { AnchorEvent, ApplicationRecord, Concept, ExportDataV2, Layout, LearningEvidence, ModelConfig, Observation, RecallRating, RetentionEvent, ReviewRequest } from '../shared/types.js';
import { MODEL_VERSION } from '../shared/types.js';
import type { ExportDataV3 } from '../shared/answer-clearing-export.js';
import type { PrivacyObservation } from '../shared/answer-clearing.js';
import type { IdentityBinding } from '../shared/identity.js';
import type { PracticeData } from '../shared/practice.js';
import type { CorrectionEvent, CorrectionStatus } from '../shared/corrections.js';
import type { RelationReviewEvent, RelationReviewStatus } from '../shared/relation-reviews.js';
import { parseRelationSuggestion } from '../shared/relation-suggestions.js';
import { DEFAULT_DAILY_REVIEW_BUDGET, type ReviewPlan } from '../shared/review-plan.js';
import { inspectLearningSchema } from './learning-schema.js';
import { inspectAnswerClearingSchemaV3 } from './answer-clearing-schema.js';
import { StoreError } from './store-error.js';
import { ObservationRevisionStoreError, readObservationRevisions } from './observation-revision-store.js';
import { normalizeLearningEvidence, parseStoredLearning, normalizeObservationEvidenceMode, practiceCardFromRow, practiceAttemptFromRow, correctionFromRow, relationReviewFromRow, parseReviewPlanRow } from './store-codecs.js';
import { decodeAnswerClearingObservation } from './answer-clearing-observation-codec.js';

type SnapshotExport<V extends 2 | 3> = V extends 3 ? ExportDataV3 : ExportDataV2;
type SnapshotObservation<V extends 2 | 3> = V extends 3 ? PrivacyObservation : Observation;
let snapshotSequence = 0;
/** Read-only repository over the caller's connection. Never initializes, opens or closes storage. */
export class LearningSnapshotRepository<V extends 2 | 3 = 2> {
  private readonly db: DatabaseSync;
  private readonly namespace: string;
  private readonly now: () => Date;
  private readonly schemaVersion: V;
  constructor(options: { db: DatabaseSync; namespace: string; now?: () => Date; schemaVersion?: V }) {
    this.db = options.db;
    this.namespace = options.namespace;
    this.now = options.now ?? (() => new Date());
    this.schemaVersion = options.schemaVersion ?? 2 as V;
    try {
      if (this.schemaVersion === 2 ? inspectLearningSchema(this.db).kind !== 'current-v2'
        : this.schemaVersion !== 3 || inspectAnswerClearingSchemaV3(this.db).kind !== 'current-v3') {
        throw new Error();
      }
    } catch {
      throw new StoreError('LEARNING_SCHEMA_UNSUPPORTED_VERSION', '快照仓库需要已初始化且版本匹配的学习数据库。', 503);
    }
  }
  exportData(source: ExportDataV2['source'], concepts: Concept[]): SnapshotExport<V> {
    return this.readSnapshot(() => this.readExportData(source, concepts));
  }
  /** Nestable snapshot over this connection; never commits or rolls back the caller's transaction. */
  readSnapshot<T>(read: () => T): T {
    const name = `lm_learning_snapshot_${++snapshotSequence}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = read();
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      try { this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); } catch { /* preserve original error and caller transaction */ }
      throw error;
    }
  }
  getConfig(): ModelConfig {
    const row = this.db.prepare('SELECT model_version, revision, half_life_days FROM main.config_history WHERE namespace = ? ORDER BY revision DESC LIMIT 1').get(this.namespace) as { model_version: string; revision: number; half_life_days: number };
    return { modelVersion: MODEL_VERSION, halfLifeDays: row.half_life_days, revision: row.revision };
  }

  getConfigHistory(): ModelConfig[] {
    const rows = this.db.prepare('SELECT revision, half_life_days FROM main.config_history WHERE namespace = ? ORDER BY revision ASC').all(this.namespace) as Array<{ revision: number; half_life_days: number }>;
    return rows.map((row) => ({ modelVersion: MODEL_VERSION, halfLifeDays: row.half_life_days, revision: row.revision }));
  }

  getPracticeData(): PracticeData {
    const cardRows = this.db.prepare(`SELECT event_id, card_id, previous_event_id, occurred_at, recorded_at,
      kind, title, prompt, reference_answer, reference_notes, sources_json, source_checked, scenario_json, paused
      FROM main.practice_cards WHERE namespace = ?
      ORDER BY occurred_at ASC, recorded_at ASC, event_id ASC`).all(this.namespace) as Array<{
        event_id: string;
        card_id: string;
        previous_event_id: string | null;
        occurred_at: string;
        recorded_at: string;
        kind: 'detail' | 'comparison' | 'scenario';
        title: string;
        prompt: string;
        reference_answer: string;
        reference_notes: string;
        sources_json: string;
        source_checked: number;
        scenario_json: string | null;
        paused: number;
      }>;
    const attemptRows = this.db.prepare(`SELECT event_id, card_id, card_event_id, answered_at, recorded_at,
      answer, confidence, confidence_at, exposure, observed_exposure, cue, outcome, check_notes, scenario_json
      FROM main.practice_attempts WHERE namespace = ?
      ORDER BY answered_at ASC, recorded_at ASC, event_id ASC`).all(this.namespace) as Array<{
        event_id: string;
        card_id: string;
        card_event_id: string;
        answered_at: string;
        recorded_at: string;
        answer: string;
        confidence: number | null;
        confidence_at: string | null;
        exposure: 'unexposed' | 'exposed' | 'unknown';
        observed_exposure: number;
        cue: 'independent' | 'hinted' | 'lookup' | 'unknown';
        outcome: 'success' | 'partial' | 'failure' | 'unverified';
        check_notes: string;
        scenario_json: string | null;
      }>;
    return {
      cards: cardRows.map((row) => practiceCardFromRow(row)),
      attempts: attemptRows.map((row) => practiceAttemptFromRow(row)),
    };
  }

  getAnchors(): AnchorEvent[] {
    const rows = this.db.prepare(`SELECT event_id, concept_id, source_revision, occurred_at, recorded_at, kind
      FROM main.anchors WHERE namespace = ? ORDER BY occurred_at ASC, recorded_at ASC, event_id ASC`).all(this.namespace) as Array<{ event_id: string; concept_id: string; source_revision: string; occurred_at: string; recorded_at: string; kind: 'review' | 'estimated' }>;
    return rows.map((row) => ({ eventId: row.event_id, conceptId: row.concept_id, sourceRevision: row.source_revision, occurredAt: row.occurred_at, recordedAt: row.recorded_at, kind: row.kind }));
  }

  getAnchorRequests(): ReviewRequest[] {
    const rows = this.db.prepare(`SELECT event_id, concept_id, source_revision, occurred_at, kind, request_payload
      FROM main.anchors WHERE namespace = ? ORDER BY occurred_at ASC, recorded_at ASC, event_id ASC`).all(this.namespace) as Array<{
        event_id: string; concept_id: string; source_revision: string; occurred_at: string;
        kind: 'review' | 'estimated'; request_payload: string;
      }>;
    return rows.map((row) => {
      try {
        const parsed = JSON.parse(row.request_payload) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            && parsed.eventId === row.event_id
            && parsed.conceptId === row.concept_id
            && parsed.sourceRevision === row.source_revision
            && (parsed.kind === 'review' || parsed.kind === 'estimated')
            && (parsed.occurredAt === undefined || typeof parsed.occurredAt === 'string')) {
          return parsed as unknown as ReviewRequest;
        }
      } catch {
        // Fall through to a conservative legacy reconstruction below.
      }
      return {
        eventId: row.event_id,
        conceptId: row.concept_id,
        sourceRevision: row.source_revision,
        kind: row.kind,
        occurredAt: row.occurred_at,
      };
    });
  }

  getConfigRecordedAt(): Record<string, string> {
    const rows = this.db.prepare(`SELECT revision, recorded_at
      FROM main.config_history WHERE namespace = ? ORDER BY revision ASC`).all(this.namespace) as Array<{ revision: number; recorded_at: string }>;
    const result: Record<string, string> = {};
    for (const row of rows) result[String(row.revision)] = row.recorded_at;
    return result;
  }

  getImportedConcepts(): Array<Pick<Concept, 'id' | 'title' | 'source'>> {
    const rows = this.db.prepare(`SELECT concept_id, title, source_path, source_revision
      FROM main.imported_concepts WHERE namespace = ? ORDER BY concept_id ASC`).all(this.namespace) as Array<{
        concept_id: string; title: string; source_path: string; source_revision: string;
      }>;
    return rows.map((row) => ({
      id: row.concept_id,
      title: row.title,
      source: { path: row.source_path, revision: row.source_revision },
    }));
  }

  getIdentityCatalog(): Array<{ id: string; title: string; path: string | null; revision: string | null }> {
    const rows = this.db.prepare(`SELECT concept_id, title, source_path, source_revision
      FROM main.identity_catalog WHERE namespace = ? ORDER BY concept_id ASC`).all(this.namespace) as Array<{
        concept_id: string; title: string; source_path: string | null; source_revision: string | null;
      }>;
    return rows.map((row) => ({
      id: row.concept_id,
      title: row.title,
      path: row.source_path,
      revision: row.source_revision,
    }));
  }

  getIdentityBindings(): IdentityBinding[] {
    const rows = this.db.prepare(`SELECT operation_id, raw_concept_id, concept_id, from_path,
      to_path, source_revision, confirmed_at, backup_id
      FROM main.identity_bindings WHERE namespace = ? ORDER BY confirmed_at ASC, operation_id ASC`).all(this.namespace) as Array<{
        operation_id: string; raw_concept_id: string; concept_id: string; from_path: string | null;
        to_path: string; source_revision: string; confirmed_at: string; backup_id: string;
      }>;
    return rows.map((row) => ({
      operationId: row.operation_id,
      rawConceptId: row.raw_concept_id,
      conceptId: row.concept_id,
      fromPath: row.from_path,
      toPath: row.to_path,
      sourceRevision: row.source_revision,
      confirmedAt: row.confirmed_at,
      backupId: row.backup_id,
    }));
  }

  getIdentityAcceptedPaths(): Record<string, string[]> {
    const paths: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
    for (const binding of this.getIdentityBindings()) {
      const values = paths[binding.conceptId] ?? [];
      if (binding.fromPath && !values.includes(binding.fromPath)) values.push(binding.fromPath);
      if (!values.includes(binding.toPath)) values.push(binding.toPath);
      paths[binding.conceptId] = values;
    }
    for (const conceptId of Object.keys(paths)) paths[conceptId].sort();
    return paths;
  }

  getObservations(conceptId?: string, sourceRevision?: string, strict = false): SnapshotObservation<V>[] {
    let query = `SELECT event_id, concept_id, source_revision, observed_at, recorded_at,
      config_revision, half_life_days, anchor_event_id, elapsed_days, decay, answer, rating, exposure, observed_exposure, learning_json, evidence_mode
      FROM main.observations WHERE namespace = ?`;
    const parameters: string[] = [this.namespace];
    if (conceptId !== undefined) {
      query += ' AND concept_id = ?';
      parameters.push(conceptId);
    }
    if (sourceRevision !== undefined) {
      query += ' AND source_revision = ?';
      parameters.push(sourceRevision);
    }
    query += ' ORDER BY observed_at ASC, recorded_at ASC, event_id ASC';
    if (this.schemaVersion === 3) {
      query = query.replace('FROM main.observations', ', request_payload, answer_cleared_at FROM main.observations');
      return this.db.prepare(query).all(...parameters).map(row => decodeAnswerClearingObservation(row)) as SnapshotObservation<V>[];
    }
    const rows = this.db.prepare(query).all(...parameters) as Array<{
        event_id: string; concept_id: string; source_revision: string; observed_at: string; recorded_at: string;
        config_revision: number; half_life_days: number; anchor_event_id: string | null; elapsed_days: number | null; decay: number | null;
        answer: string; rating: RecallRating; exposure: 'unexposed' | 'exposed' | 'unknown'; observed_exposure: number; learning_json: string | null; evidence_mode: Observation['evidenceMode'] | null;
      }>;
    return rows.map((row) => {
      let learning: LearningEvidence | undefined;
      try {
        learning = strict && row.learning_json !== null
          ? normalizeLearningEvidence(JSON.parse(row.learning_json), row.observed_at)
          : parseStoredLearning(row.learning_json);
        if (strict && row.evidence_mode !== null) normalizeObservationEvidenceMode(row.evidence_mode, row.answer);
      } catch { throw new ObservationRevisionStoreError('OBSERVATION_REVISION_DATA_INVALID', 503); }
      return {
        eventId: row.event_id,
        conceptId: row.concept_id,
        sourceRevision: row.source_revision,
        observedAt: row.observed_at,
        recordedAt: row.recorded_at,
        configRevision: row.config_revision,
        halfLifeDays: row.half_life_days,
        anchorEventId: row.anchor_event_id,
        elapsedDays: row.elapsed_days,
        decay: row.decay,
        answer: row.answer,
        rating: row.rating,
        exposure: row.exposure,
        observedExposure: Boolean(row.observed_exposure),
        ...(learning ? { learning } : {}),
        ...(row.evidence_mode !== null ? { evidenceMode: normalizeObservationEvidenceMode(row.evidence_mode, row.answer) } : {}),
      };
    }) as SnapshotObservation<V>[];
  }

  getObservationsStrict(conceptId?: string): SnapshotObservation<V>[] {
    return this.getObservations(conceptId, undefined, true);
  }

  getRetentions(): RetentionEvent[] {
    const rows = this.db.prepare(`SELECT event_id, concept_id, source_revision, occurred_at, recorded_at,
      active, previous_event_id
      FROM main.retentions WHERE namespace = ? ORDER BY occurred_at ASC, recorded_at ASC, event_id ASC`).all(this.namespace) as Array<{
        event_id: string; concept_id: string; source_revision: string; occurred_at: string; recorded_at: string;
        active: number; previous_event_id: string | null;
      }>;
    return rows.map((row) => ({
      eventId: row.event_id,
      conceptId: row.concept_id,
      sourceRevision: row.source_revision,
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
      active: Boolean(row.active),
      previousEventId: row.previous_event_id,
    }));
  }

  getApplications(conceptId?: string, sourceRevision?: string): ApplicationRecord[] {
    let query = `SELECT event_id, concept_id, source_revision, occurred_at, recorded_at,
      kind, context, content, outcome, assistance, result, limitations, insight,
      correction, references_text, relation_suggestion_json
      FROM main.applications WHERE namespace = ?`;
    const parameters: string[] = [this.namespace];
    if (conceptId !== undefined) {
      query += ' AND concept_id = ?';
      parameters.push(conceptId);
    }
    if (sourceRevision !== undefined) {
      query += ' AND source_revision = ?';
      parameters.push(sourceRevision);
    }
    query += ' ORDER BY occurred_at ASC, recorded_at ASC, event_id ASC';
    const rows = this.db.prepare(query).all(...parameters) as Array<{
      event_id: string; concept_id: string; source_revision: string; occurred_at: string; recorded_at: string;
      kind: 'application' | 'summary'; context: string; content: string;
      outcome: 'success' | 'partial' | 'failure' | 'unverified';
      assistance: 'independent' | 'resources' | 'people-or-ai' | 'mixed' | 'unknown';
      result: string; limitations: string; insight: string; correction: string; references_text: string; relation_suggestion_json: string | null;
    }>;
    return rows.map((row) => ({
      eventId: row.event_id,
      conceptId: row.concept_id,
      sourceRevision: row.source_revision,
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
      kind: row.kind,
      context: row.context,
      content: row.content,
      outcome: row.outcome,
      assistance: row.assistance,
      result: row.result,
      limitations: row.limitations,
      insight: row.insight,
      correction: row.correction,
      references: row.references_text,
      ...(row.relation_suggestion_json === null ? {} : { relationSuggestion: parseRelationSuggestion(JSON.parse(row.relation_suggestion_json), { conceptId: row.concept_id, sourceRevision: row.source_revision }) }),
    }));
  }

  getCorrections(conceptId?: string, applicationEventId?: string): CorrectionEvent[] {
    let query = `SELECT event_id, application_event_id, concept_id, source_revision,
      occurred_at, recorded_at, previous_event_id, status, note
      FROM main.corrections WHERE namespace = ?`;
    const parameters: string[] = [this.namespace];
    if (conceptId !== undefined) {
      query += ' AND concept_id = ?';
      parameters.push(conceptId);
    }
    if (applicationEventId !== undefined) {
      query += ' AND application_event_id = ?';
      parameters.push(applicationEventId);
    }
    query += ' ORDER BY occurred_at ASC, recorded_at ASC, event_id ASC';
    const rows = this.db.prepare(query).all(...parameters) as Array<{
      event_id: string;
      application_event_id: string;
      concept_id: string;
      source_revision: string;
      occurred_at: string;
      recorded_at: string;
      previous_event_id: string | null;
      status: CorrectionStatus;
      note: string;
    }>;
    return rows.map((row) => correctionFromRow(row));
  }

  getRelationReviews(conceptId?: string, applicationEventId?: string): RelationReviewEvent[] {
    let query = `SELECT event_id, application_event_id, concept_id, basis_json,
      occurred_at, recorded_at, previous_event_id, status, note
      FROM main.relation_reviews WHERE namespace = ?`;
    const parameters: string[] = [this.namespace];
    if (conceptId !== undefined) {
      query += ' AND concept_id = ?';
      parameters.push(conceptId);
    }
    if (applicationEventId !== undefined) {
      query += ' AND application_event_id = ?';
      parameters.push(applicationEventId);
    }
    query += ' ORDER BY occurred_at ASC, recorded_at ASC, event_id ASC';
    const rows = this.db.prepare(query).all(...parameters) as Array<{
      event_id: string;
      application_event_id: string;
      concept_id: string;
      basis_json: string;
      occurred_at: string;
      recorded_at: string;
      previous_event_id: string | null;
      status: RelationReviewStatus;
      note: string;
    }>;
    return rows.map((row) => relationReviewFromRow(row));
  }

  getLayout(): Layout {
    const row = this.db.prepare('SELECT layout_json FROM main.layouts WHERE namespace = ?').get(this.namespace) as { layout_json: string } | undefined;
    if (!row) return {};
    try {
      const parsed = JSON.parse(row.layout_json) as Layout;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  getReviewPlan(): ReviewPlan {
    const row = this.db.prepare(`SELECT revision, daily_budget, concepts_json
      FROM main.review_plans WHERE namespace = ?`).get(this.namespace) as {
        revision: number;
        daily_budget: number;
        concepts_json: string;
      } | undefined;
    if (!row) return { revision: 0, dailyBudget: DEFAULT_DAILY_REVIEW_BUDGET, concepts: {} };
    return parseReviewPlanRow(row);
  }

  private readExportData(source: ExportDataV2['source'], concepts: Concept[]): SnapshotExport<V> {
    const bindings = this.getIdentityBindings();
    const boundRawIds = new Set(bindings.map((binding) => binding.rawConceptId));
    const liveConcepts = concepts
      .filter((concept) => !boundRawIds.has(concept.id))
      .map((concept) => ({ id: concept.id, title: concept.title, source: concept.source }));
    const catalogConcepts = this.getIdentityCatalog()
      .filter((concept) => concept.path !== null && concept.revision !== null && !boundRawIds.has(concept.id))
      .map((concept) => ({
        id: concept.id,
        title: concept.title,
        source: { path: concept.path as string, revision: concept.revision as string },
      }));
    const mergedConcepts = new Map(this.getImportedConcepts()
      .filter((concept) => !boundRawIds.has(concept.id))
      .map((concept) => [concept.id, concept]));
    // The remembered catalog supplements imported metadata, while the current
    // knowledge index remains authoritative for a live stable ID.
    for (const concept of catalogConcepts) mergedConcepts.set(concept.id, concept);
    // The current knowledge index is authoritative when an imported orphan
    // has since become live again with the same stable concept ID.
    for (const concept of liveConcepts) mergedConcepts.set(concept.id, concept);
    const applications = this.getApplications();
    for (const application of applications) {
      if (!application.relationSuggestion) continue;
      for (const endpoint of [application.relationSuggestion.source, application.relationSuggestion.target]) {
        if (!mergedConcepts.has(endpoint.conceptId) && !boundRawIds.has(endpoint.conceptId)) {
          mergedConcepts.set(endpoint.conceptId, { id: endpoint.conceptId, title: endpoint.title, source: { path: endpoint.path, revision: endpoint.sourceRevision } });
        }
      }
    }
    const relationReviews = this.getRelationReviews();
    for (const review of relationReviews) {
      for (const endpoint of [review.basis.source.current, review.basis.target.current]) {
        if (endpoint && !mergedConcepts.has(endpoint.conceptId) && !boundRawIds.has(endpoint.conceptId)) mergedConcepts.set(endpoint.conceptId, { id: endpoint.conceptId, title: endpoint.title, source: { path: endpoint.path, revision: endpoint.sourceRevision } });
      }
    }
    const practice = this.getPracticeData();
    return {
      schemaVersion: this.schemaVersion,
      observationRevisions: readObservationRevisions(this.db, this.namespace),
      exportedAt: this.now().toISOString(),
      source,
      concepts: [...mergedConcepts.values()].sort((left, right) => left.id.localeCompare(right.id)),
      identityBindings: bindings,
      config: this.getConfig(),
      configHistory: this.getConfigHistory(),
      anchors: this.getAnchors(),
      observations: this.getObservationsStrict(),
      retentions: this.getRetentions(),
      applications,
      corrections: this.getCorrections(),
      ...(relationReviews.length ? { relationReviews } : {}),
      ...(practice.cards.length || practice.attempts.length ? { practice } : {}),
      reviewPlan: this.getReviewPlan(),
      layout: this.getLayout(),
      restoreMetadata: {
        sourceId: this.namespace,
        anchorRequests: this.getAnchorRequests(),
        configRecordedAt: this.getConfigRecordedAt(),
      },
    } as SnapshotExport<V>;
  }
}
