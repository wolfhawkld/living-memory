import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { initializeAnswerClearingSchemaV3 } from '../src/server/answer-clearing-schema.js';
import { AnswerClearingStore, AnswerClearingStoreError } from '../src/server/answer-clearing-store.js';
import { backupInstance } from '../src/server/instance-backup.js';
import { initializeLearningSchemaV2, inspectLearningSchema, LearningSchemaError } from '../src/server/learning-schema.js';
import { assertLearningDatabaseReady, Store } from '../src/server/store.js';
import { instanceFixture } from './helpers/instance-backup-fixture.js';

const instant='2026-10-22T00:00:00.000Z';

test('unconnected v3 store refuses empty/v2 connections without initializing or changing them', () => {
  for(const version of ['empty','v2'] as const) {
    const db=new DatabaseSync(':memory:');
    try {
      if(version==='v2') initializeLearningSchemaV2(db,{recordedAt:instant});
      const before=db.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
      assert.throws(()=>new AnswerClearingStore({db,namespace:'synthetic'}),error=>{
        assert.ok(error instanceof AnswerClearingStoreError); assert.equal(error.code,'ANSWER_CLEARING_SCHEMA_UNAVAILABLE');
        assert.equal(error.status,503); assert.equal(error.message,error.code); return true;
      });
      assert.deepEqual(db.prepare('SELECT * FROM sqlite_master ORDER BY name').all(),before);
      assert.equal(db.isTransaction,false); assert.equal(inspectLearningSchema(db).kind,version==='empty'?'empty':'current-v2');
    } finally {db.close();}
  }
});

test('current v2 inspection, startup, Store and full backup refuse v3 and leave its database bytes intact', async () => {
  const f=await instanceFixture();
  try {
    const path=join(f.options.dataDir,'living-memory.sqlite');
    // This helper closes every Store first. Replace only this synthetic database; no real service or private data is used.
    for(const suffix of ['', '-wal','-shm']) rmSync(path+suffix,{force:true});
    const db=new DatabaseSync(path);
    try {
      db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
      initializeAnswerClearingSchemaV3(db,{recordedAt:instant}); db.exec('COMMIT');
    } finally {db.close();}
    const before=readFileSync(path);
    const reader=new DatabaseSync(path,{readOnly:true});
    try {
      assert.throws(()=>inspectLearningSchema(reader),error=>{
        assert.ok(error instanceof LearningSchemaError); assert.equal(error.code,'LEARNING_SCHEMA_UNSUPPORTED_VERSION');return true;
      });
    } finally {reader.close();}
    assert.throws(()=>assertLearningDatabaseReady(path),{code:'LEARNING_SCHEMA_UNSUPPORTED_VERSION'});
    assert.throws(()=>new Store({dbPath:path,namespace:'synthetic'}),{code:'LEARNING_SCHEMA_UNSUPPORTED_VERSION'});
    assert.deepEqual(readFileSync(path),before);
    await assert.rejects(backupInstance(f.options),{code:'INSTANCE_DATABASE_INVALID'});
    assert.deepEqual(readFileSync(path),before);
    const verify=new DatabaseSync(path,{readOnly:true});
    try {
      assert.equal(verify.prepare('PRAGMA user_version').get()!.user_version,3);
      assert.equal(verify.prepare('SELECT count(*) AS n FROM namespaces').get()!.n,0);
    } finally {verify.close();}
  } finally {f.cleanup();}
});
