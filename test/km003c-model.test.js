import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTriggerCommand,
  clampPdm,
  cleanHex,
  commandNeedsPdm,
  DEFAULT_PDM,
  describePdo,
  deviceSupportsControl,
  LOG_LIMIT,
  outcomeHead,
  pdoToRequestFields,
  prependOutcome,
  protocolFields,
  triggerTimeoutMs,
} from '../src/km003c-model.js';

/** @param {Partial<import('../src/km003c-model.js').TriggerForm>} [over] */
const form = (over = {}) => ({ position: 2, voltMv: 9000, curMa: 3000, volt: '9V', ...over });

/** @param {Partial<import('../src/km003c-model.js').TriggerOutcome>} [over] */
const outcome = (over = {}) => ({ ok: true, message: 'ok', pdos: [], protocols: [], pdm_open: true, ...over });

test('PDM choices fall back field by field to the PD 3.0 / 20V 5A / 3A PPS default', () => {
  assert.deepEqual(clampPdm(undefined), DEFAULT_PDM);
  assert.deepEqual(clampPdm({ pdType: 2, em: 3, sink: 1 }), { pdType: 2, em: 3, sink: 1 });
  assert.deepEqual(clampPdm({ pdType: 9, em: '2', sink: 1.5 }), { pdType: 1, em: 2, sink: 0 });
  assert.deepEqual(clampPdm({ pdType: -1, em: null, sink: 'x' }), DEFAULT_PDM);
});

test('each protocol shows only the fields its command uses', () => {
  assert.deepEqual(
    ['pd', 'qc', 'qc3', 'fcp', 'scp', 'ufcs', 'bc'].map((proto) => {
      const f = protocolFields(proto);
      return [proto, f.position, f.fixedVolt, f.voltMv, f.curMa, f.qc3Adjust];
    }),
    [
      ['pd', true, false, true, true, false],
      ['qc', false, true, false, false, false],
      ['qc3', false, false, true, false, true],
      ['fcp', false, true, false, false, false],
      ['scp', false, false, true, true, false],
      ['ufcs', true, false, true, true, false],
      ['bc', false, false, false, false, false],
    ],
  );
  assert.equal(protocolFields('ufcs').positionLabel, '请求序号');
  assert.deepEqual(protocolFields('qc').voltChoices, ['5V', '9V', '12V', '20V']);
  assert.deepEqual(protocolFields('afc').voltChoices, ['5V', '9V', '12V']);
});

test('the form builds the exact command JSON the backend deserializes', () => {
  assert.deepEqual(buildTriggerCommand('pd', form()), {
    cmd: { type: 'pd_req', position: 2, volt_mv: 9000, cur_ma: 3000 },
  });
  assert.deepEqual(buildTriggerCommand('qc', form({ volt: '12V' })), { cmd: { type: 'qc', voltage: '12V' } });
  assert.deepEqual(buildTriggerCommand('qc3', form()), { cmd: { type: 'qc3', volt_mv: 9000 } });
  assert.deepEqual(buildTriggerCommand('sfcp', form()), { cmd: { type: 'sfcp', voltage: '9V' } });
  assert.deepEqual(buildTriggerCommand('vfcp', form()), { cmd: { type: 'vfcp', volt_mv: 9000, cur_ma: 3000 } });
  assert.deepEqual(buildTriggerCommand('ufcs', form()), {
    cmd: { type: 'ufcs', req: 2, volt_mv: 9000, cur_ma: 3000 },
  });
  assert.deepEqual(buildTriggerCommand('apple', form()), { cmd: { type: 'entry', protocol: 'apple' } });
});

test('invalid numbers are refused with a reason instead of being sent', () => {
  assert.match(/** @type {any} */ (buildTriggerCommand('pd', form({ position: 0 }))).error, /PDO 序号/);
  assert.match(/** @type {any} */ (buildTriggerCommand('ufcs', form({ position: 1.5 }))).error, /请求序号/);
  assert.match(/** @type {any} */ (buildTriggerCommand('scp', form({ voltMv: 70000 }))).error, /电压/);
  assert.match(/** @type {any} */ (buildTriggerCommand('pd', form({ curMa: Number.NaN }))).error, /电流/);
  assert.match(/** @type {any} */ (buildTriggerCommand('fcp', form({ volt: '20V' }))).error, /电压档位/);
  // Fields a protocol does not use are not validated.
  assert.ok('cmd' in buildTriggerCommand('qc', form({ position: 0, curMa: -1 })));
});

test('pd data keeps hex digits only and needs whole bytes', () => {
  assert.equal(cleanHex('01 8f-14 01'), '018F1401');
  assert.equal(cleanHex('abc'), null);
  assert.equal(cleanHex(''), null);
});

test('scans get the long waits, and PDM-free commands are exactly open/close/raw', () => {
  assert.equal(triggerTimeoutMs({ type: 'list', plus: false }), 120_000);
  assert.equal(triggerTimeoutMs({ type: 'list', plus: true }), 210_000);
  assert.equal(triggerTimeoutMs({ type: 'pd_req' }), 45_000);
  assert.deepEqual(
    ['pdm_open', 'pdm_close', 'raw', 'pdm_set', 'pd_pdo', 'reset'].map((type) => commandNeedsPdm({ type })),
    [false, false, false, true, true, true],
  );
});

test('outcome heads distinguish scans, successes and failures', () => {
  assert.equal(outcomeHead(outcome()), 'OK');
  assert.equal(outcomeHead(outcome({ ok: false, message: 'fail' })), 'ERR');
  assert.equal(outcomeHead(outcome({ protocols: [{ id: 'pd', label: 'PD' }] })), '检测完成');
  assert.equal(outcomeHead(outcome({ message: 'QC2.0 : OK\nFCP : FAIL' })), '检测完成');
});

test('the log shows streamed progress when the final reply is empty, newest first, bounded', () => {
  let log = prependOutcome('', outcome({ message: '(无回复)' }), 'PD : OK\nQC2.0 : OK', '10:00:00');
  assert.equal(log, '[10:00:00] OK\nPD : OK\nQC2.0 : OK');
  log = prependOutcome(
    log,
    outcome({ ok: false, message: 'request rejected', code: 'protocol_rejected' }),
    '',
    '10:00:01',
  );
  assert.ok(log.startsWith('[10:00:01] ERR\nrequest rejected\n\n[10:00:00] OK'));
  const huge = prependOutcome('', outcome({ message: 'x'.repeat(LOG_LIMIT * 2) }), '', 't');
  assert.equal(huge.length, LOG_LIMIT);
});

test('PDO rows read like the meter and fill the request form sensibly', () => {
  const fixed = {
    position: 2,
    kind: 'fixed',
    volt_min_mv: 9000,
    volt_max_mv: 9000,
    cur_ma: 3000,
    label: '',
    programmable: false,
  };
  const pps = {
    position: 4,
    kind: 'pps',
    volt_min_mv: 3300,
    volt_max_mv: 11000,
    cur_ma: 5000,
    label: '',
    programmable: true,
  };
  const battery = {
    position: 5,
    kind: 'battery',
    volt_min_mv: 5000,
    volt_max_mv: 20000,
    label: '',
    programmable: true,
  };
  assert.deepEqual(describePdo(fixed), { position: '#2', kind: '固定', voltage: '9.00 V', current: '3.00 A' });
  assert.deepEqual(describePdo(pps), { position: '#4', kind: 'PPS', voltage: '3.30–11.00 V', current: '5.00 A' });
  assert.equal(describePdo(battery).current, '—');
  assert.deepEqual(pdoToRequestFields(fixed, form({ voltMv: 5000 })), {
    proto: 'pd',
    position: 2,
    voltMv: 9000,
    curMa: 3000,
  });
  assert.equal(pdoToRequestFields(pps, form({ voltMv: 20000 })).voltMv, 11000, 'clamped into the PPS range');
  assert.equal(pdoToRequestFields(pps, form({ voltMv: 9000 })).voltMv, 9000);
  assert.equal(
    pdoToRequestFields(battery, form({ curMa: 1500 })).curMa,
    1500,
    'no nominal current keeps the form value',
  );
});

test('only POWER-Z devices offer protocol control; older payloads count as WITRN', () => {
  assert.equal(deviceSupportsControl(null), false);
  assert.equal(deviceSupportsControl({}), false);
  assert.equal(deviceSupportsControl({ family: 'witrn', controls: false }), false);
  assert.equal(deviceSupportsControl({ family: 'km003c', controls: true }), true);
  assert.equal(deviceSupportsControl({ family: 'km003c', controls: false }), false);
});
