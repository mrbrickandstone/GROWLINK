'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {jobKey} = require('./coverage.cjs');

class PilotStore {
  constructor(root) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, {recursive:true,mode:0o700});
    fs.mkdirSync(path.join(this.root,'originals'), {recursive:true,mode:0o700});
    this.db = new DatabaseSync(path.join(this.root,'pilot.sqlite'));
    fs.chmodSync(path.join(this.root,'pilot.sqlite'),0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, request TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
        owner TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0, result TEXT);
      CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, at INTEGER NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  meta(key,value) { if(value===undefined) { const row=this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key);return row?JSON.parse(row.value):null; }
    this.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value)); }
  enqueue(request) {
    const id=jobKey(request.cameraId,request.componentId,request.start,request.end);
    this.db.prepare('INSERT OR IGNORE INTO jobs (id,request) VALUES (?,?)').run(id,JSON.stringify(request));
    return id;
  }
  claim(now=Date.now()) {
    const owner=crypto.randomUUID();
    const row=this.db.prepare(`UPDATE jobs SET state='running',owner=?,lease_until=?,attempts=attempts+1
      WHERE id=(SELECT id FROM jobs WHERE (state='queued' AND next_at<=?) OR (state='running' AND lease_until<=?) ORDER BY rowid LIMIT 1)
      RETURNING *`).get(owner,now+10*60000,now,now);
    return row?{...row,request:JSON.parse(row.request)}:null;
  }
  finish(job,state,result,nextAt=0) {
    if(!['queued','complete','partial','failed','blocked'].includes(state))throw new Error('INVALID_JOB_STATE');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const update=this.db.prepare("UPDATE jobs SET state=?,result=?,next_at=?,owner=NULL,lease_until=NULL WHERE id=? AND owner=? AND state='running'")
        .run(state,JSON.stringify(result),nextAt,job.id,job.owner);
      if(update.changes!==1)throw new Error('LEASE_LOST');
      this.db.prepare('INSERT INTO attempts(job_id,at,result) VALUES (?,?,?)').run(job.id,Date.now(),JSON.stringify(result));
      this.db.exec('COMMIT');
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
  }
  list() {return this.db.prepare('SELECT id,request,state,attempts,result,next_at FROM jobs ORDER BY rowid').all().map(j=>({...j,request:JSON.parse(j.request),result:j.result?JSON.parse(j.result):null}));}
  attempts() {return this.db.prepare('SELECT job_id,at,result FROM attempts ORDER BY id').all().map(j=>({...j,result:JSON.parse(j.result)}));}
  requeueReviewedHost(id) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row=this.db.prepare('SELECT state,result FROM jobs WHERE id=?').get(id);
      if(row?.state!=='blocked'||JSON.parse(row.result||'null')?.code!=='MEDIA_REDIRECT_REQUIRES_HOST_REVIEW')throw new Error('JOB_NOT_BLOCKED_ON_HOST_REVIEW');
      this.db.prepare("UPDATE jobs SET state='queued',next_at=0 WHERE id=?").run(id);
      this.db.prepare('INSERT INTO attempts(job_id,at,result) VALUES (?,?,?)').run(id,Date.now(),JSON.stringify({code:'REQUEUED_AFTER_MEDIA_HOST_REVIEW',requestUnchanged:true}));
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  invalidate(id) {
    this.db.prepare("UPDATE jobs SET state='queued',next_at=0,result=NULL WHERE id=? AND state IN ('complete','partial')").run(id);
    this.db.prepare('INSERT INTO attempts(job_id,at,result) VALUES (?,?,?)').run(id,Date.now(),JSON.stringify({code:'LOCAL_MEDIA_RECONCILIATION_FAILED'}));
  }
  close() {this.db.close();}
}
module.exports={PilotStore};
