import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createLegacyLearningFixture, LEGACY_LEARNING_SCHEMA_SQL, type LegacyLearningVariant } from './helpers/legacy-learning-schema.js';

const TABLES = ['activity_deletions','activity_deliveries','activity_events','activity_settings','anchors','applications','config_history',
  'corrections','identity_bindings','identity_catalog','import_receipts','imported_concepts','layouts','namespaces','observations',
  'practice_attempts','practice_card_sources','practice_cards','relation_reviews','retentions','review_plans'];
function memory(variant: LegacyLearningVariant = 'current') {
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
  const fixture=createLegacyLearningFixture(db,variant);return {db,fixture};
}
function tableNames(db: DatabaseSync) { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>String(row.name)); }
function columns(db: DatabaseSync, table: string) { return db.prepare(`PRAGMA table_info(${table})`).all().map(row=>String(row.name)); }

test('fixed current legacy fixture has all 21 tables, 14 explicit indexes and unchanged pragma ownership', () => {
  const {db}=memory();
  try {
    assert.deepEqual(tableNames(db),TABLES);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").get()!.n,14);
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,0);
    assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys,1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(db.prepare('PRAGMA foreign_key_list(practice_card_sources)').all().length,2);
    for(const table of TABLES.filter(table=>table!=='practice_card_sources'))assert.deepEqual(db.prepare(`PRAGMA foreign_key_list(${table})`).all(),[]);
    assert.doesNotMatch(LEGACY_LEARNING_SCHEMA_SQL,/observation_revisions|learning_schema|BEGIN|COMMIT|user_version/i);
  } finally {db.close();}
});

test('seeded namespaces preserve same-time rowid practice chains, raw payloads, zero budget and activity reception time', () => {
  const {db,fixture}=memory();
  try {
    for(const [index,namespace] of fixture.namespaces.entries()){
      const cards=db.prepare('SELECT rowid,* FROM practice_cards WHERE namespace=? ORDER BY rowid').all(namespace);
      assert.deepEqual(cards.map(row=>row.event_id),[fixture.eventIds.practiceRoot,fixture.eventIds.practiceTail]);
      assert.deepEqual(cards.map(row=>row.rowid),[index*100+101,index*100+102]);
      assert.equal(cards[0].occurred_at,cards[1].occurred_at);assert.equal(cards[0].recorded_at,cards[1].recorded_at);
      assert.equal(cards[1].previous_event_id,cards[0].event_id);
      assert.equal(JSON.parse(String(cards[1].request_payload)).previousEventId,fixture.eventIds.practiceRoot);
      assert.equal(db.prepare('SELECT count(*) AS n FROM practice_card_sources WHERE namespace=?').get(namespace)!.n,2);
      const observation=db.prepare('SELECT request_payload,answer FROM observations WHERE namespace=?').get(namespace)!;
      assert.equal(JSON.parse(String(observation.request_payload)).answer,observation.answer);
      assert.equal(JSON.parse(String(observation.request_payload)).eventId,fixture.eventIds.observation);
      assert.deepEqual(db.prepare('SELECT revision,daily_budget FROM review_plans WHERE namespace=?').get(namespace),Object.assign(Object.create(null),{revision:7,daily_budget:0}));
      assert.deepEqual(JSON.parse(String(db.prepare('SELECT layout_json FROM layouts WHERE namespace=?').get(namespace)!.layout_json)),{'concept-original':{x:1,y:-2,z:3}});
      const activity=db.prepare('SELECT occurred_at,received_at,event_json FROM activity_events WHERE namespace=?').get(namespace)!;
      assert.equal(activity.occurred_at,fixture.occurredAt);assert.equal(activity.received_at,fixture.recordedAt);
      assert.equal(JSON.parse(String(activity.event_json)).occurredAt,fixture.occurredAt);
      assert.equal(db.prepare('SELECT request_hash FROM import_receipts WHERE namespace=?').get(namespace)!.request_hash,'frozen-request-hash');
    }
  } finally {db.close();}
});

test('historical ALTER order is separate from fresh column order while original requests remain byte-identical', () => {
  const fresh=memory(),altered=memory('altered-column-order');
  try {
    for(const [table,fields] of [['observations',['learning_json','evidence_mode']],['applications',['relation_suggestion_json']],['practice_attempts',['scenario_json']]] as const){
      const current=columns(fresh.db,table),old=columns(altered.db,table);
      for(const field of fields){assert.ok(current.indexOf(field)<current.indexOf('request_payload'));assert.ok(old.indexOf(field)>old.indexOf('request_payload'));}
      assert.deepEqual([...current].sort(),[...old].sort());
    }
    for(const table of ['anchors','observations','practice_cards','practice_attempts','import_receipts']){
      const column=table==='import_receipts'?'receipt_json':'request_payload';
      assert.deepEqual(altered.db.prepare(`SELECT namespace,${column} FROM ${table} ORDER BY namespace`).all(),fresh.db.prepare(`SELECT namespace,${column} FROM ${table} ORDER BY namespace`).all());
    }
  } finally {fresh.db.close();altered.db.close();}
});

test('pre-scenario practice fixture retains old CHECK, child rows, rowids and absent scenario fields without migration', () => {
  const {db,fixture}=memory('pre-scenario');
  try {
    const sql=String(db.prepare("SELECT sql FROM sqlite_master WHERE name='practice_cards'").get()!.sql);
    assert.match(sql,/CHECK\(kind IN \('detail', 'comparison'\)\)/);assert.doesNotMatch(sql,/'scenario'/);
    assert.equal(columns(db,'practice_cards').includes('scenario_json'),false);assert.equal(columns(db,'practice_attempts').includes('scenario_json'),false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM practice_card_sources').get()!.n,4);
    assert.deepEqual(db.prepare('SELECT rowid FROM practice_cards ORDER BY rowid').all().map(row=>row.rowid),[101,102,201,202]);
    assert.equal(db.prepare('SELECT previous_event_id FROM practice_cards WHERE namespace=? AND event_id=?').get(fixture.namespaces[0],fixture.eventIds.practiceTail)!.previous_event_id,fixture.eventIds.practiceRoot);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally {db.close();}
});

test('absent and partial activity stay distinct from the unsupported ancient five-table sample', () => {
  const none=memory('activity-none'),partial=memory('activity-partial'),ancient=memory('ancient-five-table');
  try {
    assert.equal(tableNames(none.db).length,17);assert.equal(tableNames(none.db).some(name=>name.startsWith('activity_')),false);
    assert.deepEqual(tableNames(partial.db).filter(name=>name.startsWith('activity_')),['activity_events']);
    assert.deepEqual(columns(partial.db,'activity_events'),['synthetic']);
    assert.deepEqual(tableNames(ancient.db),['anchors','config_history','layouts','namespaces','observations']);
    assert.equal(columns(ancient.db,'observations').includes('learning_json'),false);
    assert.equal(columns(ancient.db,'observations').includes('evidence_mode'),false);
    assert.equal(ancient.db.prepare('SELECT count(*) AS n FROM observations').get()!.n,2);
    assert.equal(Object.hasOwn(JSON.parse(String(ancient.db.prepare('SELECT request_payload FROM observations LIMIT 1').get()!.request_payload)),'learning'),false);
  } finally {none.db.close();partial.db.close();ancient.db.close();}
});

test('tampered CHECK, primary key, foreign key, index direction and unknown table samples stay distinguishable', () => {
  for(const variant of ['bad-check','bad-pk','bad-fk','bad-index-direction','unknown-extra'] as const){
    const {db}=memory(variant);
    try {
      if(variant==='bad-check')assert.match(String(db.prepare("SELECT sql FROM sqlite_master WHERE name='observations'").get()!.sql),/'CLEAR'/);
      if(variant==='bad-pk')assert.equal(db.prepare('PRAGMA table_info(anchors)').all().find(column=>column.name==='namespace')!.pk,0);
      if(variant==='bad-fk')assert.equal(db.prepare('PRAGMA foreign_key_list(practice_card_sources)').all()[0].on_delete,'RESTRICT');
      if(variant==='bad-index-direction')assert.equal(db.prepare('PRAGMA index_xinfo(anchors_by_concept_history)').all().find(column=>column.name==='occurred_at')!.desc,0);
      if(variant==='unknown-extra')assert.equal(tableNames(db).includes('unexpected_private_state'),true);
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,0);
    } finally {db.close();}
  }
});
