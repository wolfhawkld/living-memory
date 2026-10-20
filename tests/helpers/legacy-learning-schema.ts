import type { DatabaseSync } from 'node:sqlite';

/** Fixed pre-revision learning schema copied for synthetic compatibility tests. */
export const LEGACY_LEARNING_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS namespaces (
        namespace TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS config_history (
        namespace TEXT NOT NULL,
        revision INTEGER NOT NULL,
        model_version TEXT NOT NULL,
        half_life_days REAL NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY(namespace, revision)
      );
      CREATE TABLE IF NOT EXISTS anchors (
        namespace TEXT NOT NULL,
        event_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('review', 'estimated')),
        request_payload TEXT NOT NULL,
        PRIMARY KEY(namespace, event_id)
      );
      CREATE TABLE IF NOT EXISTS observations (
        namespace TEXT NOT NULL,
        event_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        config_revision INTEGER NOT NULL,
        half_life_days REAL NOT NULL,
        anchor_event_id TEXT,
        elapsed_days REAL,
        decay REAL,
        answer TEXT NOT NULL,
        rating TEXT NOT NULL CHECK(rating IN ('clear', 'partial', 'blank')),
        exposure TEXT NOT NULL CHECK(exposure IN ('unexposed', 'exposed', 'unknown')),
        observed_exposure INTEGER NOT NULL CHECK(observed_exposure IN (0, 1)),
        learning_json TEXT,
        evidence_mode TEXT,
        request_payload TEXT NOT NULL,
        PRIMARY KEY(namespace, event_id)
      );
      CREATE TABLE IF NOT EXISTS retentions (
        namespace TEXT NOT NULL,
        event_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        active INTEGER NOT NULL CHECK(active IN (0, 1)),
        previous_event_id TEXT,
        request_payload TEXT NOT NULL,
        PRIMARY KEY(namespace, event_id)
      );
      CREATE TABLE IF NOT EXISTS applications (
        namespace TEXT NOT NULL,
        event_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('application', 'summary')),
        context TEXT NOT NULL,
        content TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('success', 'partial', 'failure', 'unverified')),
        assistance TEXT NOT NULL CHECK(assistance IN ('independent', 'resources', 'people-or-ai', 'mixed', 'unknown')),
        result TEXT NOT NULL,
        limitations TEXT NOT NULL,
        insight TEXT NOT NULL,
        correction TEXT NOT NULL,
        references_text TEXT NOT NULL,
        relation_suggestion_json TEXT,
        request_payload TEXT NOT NULL,
        PRIMARY KEY(namespace, event_id)
      );
      CREATE TABLE IF NOT EXISTS corrections (
        namespace TEXT NOT NULL,
        event_id TEXT NOT NULL,
        application_event_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        previous_event_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('resolved', 'dismissed', 'open')),
        note TEXT NOT NULL,
        request_payload TEXT NOT NULL,
        PRIMARY KEY(namespace, event_id)
      );
      CREATE TABLE IF NOT EXISTS relation_reviews (
        namespace TEXT NOT NULL,
        event_id TEXT NOT NULL,
        application_event_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        previous_event_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('resolved', 'dismissed', 'open')),
        note TEXT NOT NULL,
        basis_json TEXT NOT NULL,
        request_payload TEXT NOT NULL,
        PRIMARY KEY(namespace, event_id)
      );
      CREATE INDEX IF NOT EXISTS relation_reviews_by_application
        ON relation_reviews(namespace, application_event_id, occurred_at, recorded_at, event_id);
      CREATE TABLE IF NOT EXISTS practice_cards (
        namespace TEXT NOT NULL,
        event_id TEXT NOT NULL,
        card_id TEXT NOT NULL,
        previous_event_id TEXT,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('detail', 'comparison', 'scenario')),
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        reference_answer TEXT NOT NULL,
        reference_notes TEXT NOT NULL,
        sources_json TEXT NOT NULL,
        source_checked INTEGER NOT NULL CHECK(source_checked = 1),
        scenario_json TEXT,
        paused INTEGER NOT NULL CHECK(paused IN (0, 1)),
        request_payload TEXT NOT NULL,
        PRIMARY KEY(namespace, event_id)
      );
      CREATE TABLE IF NOT EXISTS practice_attempts (
        namespace TEXT NOT NULL,
        event_id TEXT NOT NULL,
        card_id TEXT NOT NULL,
        card_event_id TEXT NOT NULL,
        answered_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        answer TEXT NOT NULL,
        confidence INTEGER,
        confidence_at TEXT,
        exposure TEXT NOT NULL CHECK(exposure IN ('unexposed', 'exposed', 'unknown')),
        observed_exposure INTEGER NOT NULL CHECK(observed_exposure IN (0, 1)),
        cue TEXT NOT NULL CHECK(cue IN ('independent', 'hinted', 'lookup', 'unknown')),
        outcome TEXT NOT NULL CHECK(outcome IN ('success', 'partial', 'failure', 'unverified')),
        check_notes TEXT NOT NULL,
        scenario_json TEXT,
        request_payload TEXT NOT NULL,
        PRIMARY KEY(namespace, event_id)
      );
      CREATE TABLE IF NOT EXISTS practice_card_sources (
        namespace TEXT NOT NULL,
        card_event_id TEXT NOT NULL,
        card_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        PRIMARY KEY(namespace, card_event_id, concept_id),
        FOREIGN KEY(namespace, card_event_id) REFERENCES practice_cards(namespace, event_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS layouts (
        namespace TEXT PRIMARY KEY,
        layout_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_plans (
        namespace TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        daily_budget INTEGER NOT NULL,
        concepts_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS imported_concepts (
        namespace TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        title TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        PRIMARY KEY(namespace, concept_id)
      );
      CREATE TABLE IF NOT EXISTS identity_catalog (
        namespace TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        title TEXT NOT NULL,
        source_path TEXT,
        source_revision TEXT,
        PRIMARY KEY(namespace, concept_id)
      );
      CREATE TABLE IF NOT EXISTS identity_bindings (
        namespace TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        raw_concept_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        from_path TEXT,
        to_path TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        backup_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        PRIMARY KEY(namespace, operation_id),
        UNIQUE(namespace, raw_concept_id)
      );
      CREATE TABLE IF NOT EXISTS import_receipts (
        namespace TEXT NOT NULL,
        import_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        PRIMARY KEY(namespace, import_id)
      );
      CREATE INDEX IF NOT EXISTS anchors_by_concept_time
        ON anchors(namespace, concept_id, occurred_at, recorded_at);
      CREATE INDEX IF NOT EXISTS observations_by_concept
        ON observations(namespace, concept_id, observed_at);
      CREATE INDEX IF NOT EXISTS anchors_by_concept_history
        ON anchors(namespace, concept_id, occurred_at DESC, recorded_at DESC, event_id DESC);
      CREATE INDEX IF NOT EXISTS observations_by_concept_history
        ON observations(namespace, concept_id, observed_at DESC, recorded_at DESC, event_id DESC);
      CREATE INDEX IF NOT EXISTS retentions_by_concept_history
        ON retentions(namespace, concept_id, occurred_at DESC, recorded_at DESC, event_id DESC);
      CREATE INDEX IF NOT EXISTS applications_by_concept_history
        ON applications(namespace, concept_id, occurred_at DESC, recorded_at DESC, event_id DESC);
      CREATE INDEX IF NOT EXISTS corrections_by_application_history
        ON corrections(namespace, application_event_id, occurred_at DESC, recorded_at DESC, event_id DESC);
      CREATE INDEX IF NOT EXISTS corrections_by_concept_history
        ON corrections(namespace, concept_id, occurred_at DESC, recorded_at DESC, event_id DESC);
      CREATE INDEX IF NOT EXISTS practice_cards_by_card
        ON practice_cards(namespace, card_id, occurred_at, recorded_at, event_id);
      CREATE INDEX IF NOT EXISTS practice_attempts_by_card
        ON practice_attempts(namespace, card_id, answered_at, recorded_at, event_id);
      CREATE INDEX IF NOT EXISTS practice_sources_by_concept
        ON practice_card_sources(namespace, concept_id, card_event_id);
      CREATE INDEX IF NOT EXISTS identity_bindings_by_concept
        ON identity_bindings(namespace, concept_id, confirmed_at, operation_id);

      CREATE TABLE IF NOT EXISTS activity_settings (
        namespace TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        epoch INTEGER NOT NULL,
        revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity_events (
        namespace TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        step_key TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        channel TEXT NOT NULL,
        event_json TEXT NOT NULL,
        recorded_by TEXT NOT NULL,
        reference_inspections TEXT NOT NULL,
        PRIMARY KEY(namespace, event_id),
        UNIQUE(namespace, epoch, operation_id, step_key)
      );
      CREATE INDEX IF NOT EXISTS activity_events_page ON activity_events(namespace, occurred_at DESC, event_id DESC);
      CREATE TABLE IF NOT EXISTS activity_deliveries (
        namespace TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        received_at TEXT NOT NULL,
        recorded_by TEXT NOT NULL,
        PRIMARY KEY(namespace, delivery_id)
      );
      CREATE TABLE IF NOT EXISTS activity_deletions (
        namespace TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        operation_id TEXT NOT NULL,
        deleted_at TEXT NOT NULL,
        PRIMARY KEY(namespace, epoch, operation_id)
      );
    `;

export type LegacyLearningVariant = 'current' | 'fresh' | 'altered-column-order' | 'pre-scenario'
  | 'activity-none' | 'activity-partial' | 'ancient-five-table' | 'bad-check' | 'bad-pk' | 'bad-fk' | 'bad-index-direction' | 'unknown-extra';
const namespaces = ['legacy-a', 'legacy-b'] as const;
const eventIds = { observation: 'observation-original', anchor: 'anchor-original', practiceRoot: 'practice-z', practiceTail: 'practice-a',
  practiceAttempt: 'practice-attempt', activity: 'activity-original' } as const;
const occurredAt = '2026-10-18T00:02:00.000Z';
const recordedAt = '2026-10-18T00:04:00.000Z';

function variantSql(variant: LegacyLearningVariant): string {
  if (variant === 'ancient-five-table') return `
    CREATE TABLE namespaces(namespace TEXT PRIMARY KEY,created_at TEXT NOT NULL);
    CREATE TABLE config_history(namespace TEXT NOT NULL,revision INTEGER NOT NULL,model_version TEXT NOT NULL,half_life_days REAL NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(namespace,revision));
    CREATE TABLE anchors(namespace TEXT NOT NULL,event_id TEXT NOT NULL,concept_id TEXT NOT NULL,source_revision TEXT NOT NULL,occurred_at TEXT NOT NULL,recorded_at TEXT NOT NULL,kind TEXT NOT NULL,request_payload TEXT NOT NULL,PRIMARY KEY(namespace,event_id));
    CREATE TABLE observations(namespace TEXT NOT NULL,event_id TEXT NOT NULL,concept_id TEXT NOT NULL,source_revision TEXT NOT NULL,observed_at TEXT NOT NULL,recorded_at TEXT NOT NULL,config_revision INTEGER NOT NULL,half_life_days REAL NOT NULL,anchor_event_id TEXT,elapsed_days REAL,decay REAL,answer TEXT NOT NULL,rating TEXT NOT NULL,exposure TEXT NOT NULL,observed_exposure INTEGER NOT NULL,request_payload TEXT NOT NULL,PRIMARY KEY(namespace,event_id));
    CREATE TABLE layouts(namespace TEXT PRIMARY KEY,layout_json TEXT NOT NULL,recorded_at TEXT NOT NULL);`;
  let sql = LEGACY_LEARNING_SCHEMA_SQL;
  if (variant === 'altered-column-order') {
    // Historical ALTERs append nullable fields after request_payload, unlike fresh DDL.
    for (const [table, columns] of [['observations', ['learning_json', 'evidence_mode']],
      ['applications', ['relation_suggestion_json']], ['practice_attempts', ['scenario_json']]] as const) {
      const expression = new RegExp(`(CREATE TABLE IF NOT EXISTS ${table} \\()([\\s\\S]*?)(\\n      \\);)`);
      sql = sql.replace(expression, (_match, prefix: string, body: string, suffix: string) => {
        for (const name of columns) body = body.replace(new RegExp(`^        ${name} TEXT,\\n`, 'm'), '');
        return prefix + body + suffix;
      });
      for (const name of columns) sql += `\nALTER TABLE ${table} ADD COLUMN ${name} TEXT;`;
    }
  }
  if (variant === 'pre-scenario') {
    sql = sql.replace("CHECK(kind IN ('detail', 'comparison', 'scenario'))", "CHECK(kind IN ('detail', 'comparison'))")
      .replace(/^        scenario_json TEXT,\n/gm, '');
  }
  if (variant === 'activity-none' || variant === 'activity-partial') {
    sql = sql.replace(/      CREATE TABLE IF NOT EXISTS activity_[\s\S]*?\n      \);\n/g, '')
      .replace(/      CREATE INDEX IF NOT EXISTS activity_events_page[^;]+;\n/, '');
    if (variant === 'activity-partial') sql += '\nCREATE TABLE activity_events(synthetic TEXT);';
  }
  if (variant === 'bad-check') sql = sql.replace("CHECK(rating IN ('clear', 'partial', 'blank'))", "CHECK(rating IN ('CLEAR', 'partial', 'blank'))");
  if (variant === 'bad-pk') sql = sql.replace(/(CREATE TABLE IF NOT EXISTS anchors[\s\S]*?)PRIMARY KEY\(namespace, event_id\)/, '$1PRIMARY KEY(event_id)');
  if (variant === 'bad-fk') sql = sql.replace('ON DELETE CASCADE', 'ON DELETE RESTRICT');
  if (variant === 'bad-index-direction') sql = sql.replace('ON anchors(namespace, concept_id, occurred_at DESC, recorded_at DESC, event_id DESC)', 'ON anchors(namespace, concept_id, occurred_at ASC, recorded_at DESC, event_id DESC)');
  if (variant === 'unknown-extra') sql += '\nCREATE TABLE unexpected_private_state(value TEXT);';
  return sql;
}
function insert(db: DatabaseSync, table: string, record: Record<string, unknown>) {
  const columns = Object.keys(record);
  db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    .run(...Object.values(record) as (string | number | null)[]);
}
/** Caller supplies an empty synthetic database and owns its lifetime/transactions. No Store or migrations run. */
export function createLegacyLearningFixture(db: DatabaseSync, variant: LegacyLearningVariant = 'current') {
  db.exec(variantSql(variant));
  const hasActivity = variant !== 'activity-none' && variant !== 'activity-partial';
  const columns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name));
  const observationColumns = columns('observations'), cardColumns = columns('practice_cards'), attemptColumns = columns('practice_attempts');
  for (const [index, namespace] of namespaces.entries()) {
    const anchorId = variant === 'bad-pk' ? `${eventIds.anchor}-${index}` : eventIds.anchor;
    insert(db, 'namespaces', { namespace, created_at: '2026-10-17T00:00:00.000Z' });
    insert(db, 'config_history', { namespace, revision: 1, model_version: 'time-only-v0', half_life_days: 7, recorded_at: '2026-10-17T00:00:00.000Z' });
    const anchor = { eventId: anchorId, conceptId: 'concept-original', sourceRevision: 'revision-original', kind: 'review', occurredAt: '2026-10-17T00:02:00.000Z' };
    insert(db, 'anchors', { namespace, event_id: anchorId, concept_id: anchor.conceptId, source_revision: anchor.sourceRevision,
      occurred_at: anchor.occurredAt, recorded_at: anchor.occurredAt, kind: anchor.kind, request_payload: JSON.stringify(anchor) });
    const observation = { eventId: eventIds.observation, conceptId: anchor.conceptId, sourceRevision: anchor.sourceRevision,
      observedAt: occurredAt, configRevision: 1, anchorEventId: anchorId, answer: 'Synthetic frozen answer',
      rating: 'partial', exposure: 'unknown', observedExposure: false,
      learning: { task: 'concept', confidence: 80, confidenceAt: '2026-10-18T00:01:00.000Z', cue: 'independent', outcome: 'partial', basis: 'self-check' } };
    const { learning: _learning, ...preEvidenceRequest } = observation;
    insert(db, 'observations', { namespace, event_id: observation.eventId, concept_id: observation.conceptId, source_revision: observation.sourceRevision,
      observed_at: occurredAt, recorded_at: recordedAt, config_revision: 1, half_life_days: 7, anchor_event_id: anchorId, elapsed_days: 1,
      decay: 2 ** (-1 / 7), answer: observation.answer, rating: observation.rating, exposure: observation.exposure, observed_exposure: 0,
      ...(observationColumns.has('learning_json') ? { learning_json: JSON.stringify(observation.learning) } : {}),
      ...(observationColumns.has('evidence_mode') ? { evidence_mode: null } : {}),
      request_payload: JSON.stringify(observationColumns.has('learning_json') ? observation : preEvidenceRequest) });
    if (variant === 'ancient-five-table') {
      insert(db, 'layouts', { namespace, layout_json: JSON.stringify({ [anchor.conceptId]: { x: 1, y: -2, z: 3 } }), recorded_at: recordedAt });
      continue;
    }
    const root = { eventId: eventIds.practiceRoot, cardId: 'practice-card', previousEventId: null as string | null,
      occurredAt: '2026-10-18T00:01:00.000Z', kind: 'detail', title: 'Frozen title', prompt: 'Frozen prompt', referenceAnswer: 'Frozen answer',
      referenceNotes: '', sources: [{ conceptId: anchor.conceptId, sourceRevision: anchor.sourceRevision }], sourceChecked: true, paused: false };
    const tail = { ...root, eventId: eventIds.practiceTail, previousEventId: root.eventId, title: 'Later frozen title' };
    for (const [position, card] of [root, tail].entries()) {
      insert(db, 'practice_cards', { rowid: index * 100 + position + 101, namespace, event_id: card.eventId, card_id: card.cardId,
        previous_event_id: card.previousEventId, occurred_at: card.occurredAt, recorded_at: recordedAt, kind: card.kind, title: card.title,
        prompt: card.prompt, reference_answer: card.referenceAnswer, reference_notes: card.referenceNotes, sources_json: JSON.stringify(card.sources),
        source_checked: 1, ...(cardColumns.has('scenario_json') ? { scenario_json: null } : {}), paused: 0, request_payload: JSON.stringify(card) });
      insert(db, 'practice_card_sources', { rowid: index * 100 + position + 121, namespace, card_event_id: card.eventId, card_id: card.cardId,
        concept_id: anchor.conceptId, source_revision: anchor.sourceRevision });
    }
    const attempt = { eventId: eventIds.practiceAttempt, cardId: root.cardId, cardEventId: tail.eventId, answeredAt: occurredAt,
      answer: 'Frozen practice answer', confidence: null, confidenceAt: null, exposure: 'unknown', observedExposure: false,
      cue: 'independent', outcome: 'partial', checkNotes: '' };
    insert(db, 'practice_attempts', { rowid: index * 100 + 111, namespace, event_id: attempt.eventId, card_id: attempt.cardId,
      card_event_id: attempt.cardEventId, answered_at: attempt.answeredAt, recorded_at: recordedAt, answer: attempt.answer,
      confidence: null, confidence_at: null, exposure: attempt.exposure, observed_exposure: 0, cue: attempt.cue, outcome: attempt.outcome,
      check_notes: '', ...(attemptColumns.has('scenario_json') ? { scenario_json: null } : {}), request_payload: JSON.stringify(attempt) });
    insert(db, 'import_receipts', { namespace, import_id: 'original-import', request_hash: 'frozen-request-hash', receipt_json: JSON.stringify({ status: 'accepted', importedAt: recordedAt }) });
    insert(db, 'review_plans', { namespace, revision: 7, daily_budget: 0, concepts_json: '{}', recorded_at: recordedAt });
    insert(db, 'layouts', { namespace, layout_json: JSON.stringify({ [anchor.conceptId]: { x: 1, y: -2, z: 3 } }), recorded_at: recordedAt });
    if (hasActivity) {
      const event = { schemaVersion: 1, eventId: eventIds.activity, operationId: 'activity-operation', stepKey: 'query-submitted',
        occurredAt, actor: { kind: 'user' }, channel: 'web', kind: 'query.submitted', refs: [], payload: { resultCount: 0 } };
      insert(db, 'activity_settings', { namespace, enabled: 1, epoch: 2, revision: 3 });
      insert(db, 'activity_events', { namespace, epoch: 2, event_id: event.eventId, operation_id: event.operationId, step_key: event.stepKey,
        occurred_at: occurredAt, received_at: recordedAt, kind: event.kind, channel: event.channel, event_json: JSON.stringify(event),
        recorded_by: JSON.stringify({ principalId: namespace, sessionKind: 'accounts' }), reference_inspections: '[]' });
      insert(db, 'activity_deliveries', { namespace, delivery_id: 'activity-delivery', event_id: event.eventId, received_at: recordedAt,
        channel: 'web', recorded_by: JSON.stringify({ principalId: namespace, sessionKind: 'accounts' }) });
      insert(db, 'activity_deletions', { namespace, epoch: 2, operation_id: 'deleted-operation', deleted_at: recordedAt });
    }
  }
  return { namespaces, eventIds, occurredAt, recordedAt };
}
