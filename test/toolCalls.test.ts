import './env.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { pool } from '../src/db.js';
import { decisionGuard, ingestDecision, undoGuard } from '../src/toolCalls.js';

after(() => pool.end());

test('decisions only leave pending', () => {
  assert.equal(decisionGuard({ tier: 'approve', decision: 'pending' }, 'approved'), null);
  assert.equal(decisionGuard({ tier: 'approve', decision: 'pending' }, 'denied'), null);
  for (const decision of ['auto', 'approved', 'denied', 'blocked'] as const) {
    for (const next of ['approved', 'denied'] as const) {
      assert.equal(decisionGuard({ tier: 'approve', decision }, next)?.code, 'not_pending');
    }
  }
});

test('deny tier can never be approved, even from pending', () => {
  for (const decision of ['auto', 'pending', 'approved', 'denied', 'blocked'] as const) {
    assert.equal(decisionGuard({ tier: 'deny', decision }, 'approved')?.code, 'tier_denied');
  }
});

test('ingest records every pair outside the contract as blocked', () => {
  assert.equal(ingestDecision('auto', 'auto'), 'auto');
  assert.equal(ingestDecision('approve', 'pending'), 'pending');
  assert.equal(ingestDecision('deny', 'blocked'), 'blocked');
  assert.equal(ingestDecision('approve', 'blocked'), 'blocked');
  assert.equal(ingestDecision('deny', 'pending'), 'blocked');
  assert.equal(ingestDecision('deny', 'auto'), 'blocked');
  assert.equal(ingestDecision('approve', 'auto'), 'blocked');
  assert.equal(ingestDecision('auto', 'pending'), 'blocked');
});

test('undo needs a command and a success', () => {
  const good = { decision: 'approved', exit_code: 0, undo_command: 'x', undo_of: null } as const;
  assert.equal(undoGuard(good, []), null);
  assert.equal(undoGuard({ ...good, decision: 'auto' }, []), null);
  assert.equal(undoGuard({ ...good, undo_command: null }, [])?.code, 'not_undoable');
  assert.equal(undoGuard({ ...good, exit_code: 1 }, [])?.code, 'not_undoable');
  assert.equal(undoGuard({ ...good, exit_code: null }, [])?.code, 'not_undoable');
  assert.equal(undoGuard({ ...good, decision: 'denied' }, [])?.code, 'not_undoable');
  assert.equal(undoGuard({ ...good, decision: 'blocked' }, [])?.code, 'not_undoable');
  assert.equal(undoGuard({ ...good, undo_of: 9 }, [])?.code, 'not_undoable');
});

test('undo runs once, but a failed attempt may be retried', () => {
  const good = { decision: 'approved', exit_code: 0, undo_command: 'x', undo_of: null } as const;
  assert.equal(undoGuard(good, [{ exit_code: 0 }])?.code, 'already_undone');
  assert.equal(undoGuard(good, [{ exit_code: null }])?.code, 'already_undone');
  assert.equal(undoGuard(good, [{ exit_code: 1 }]), null);
});
