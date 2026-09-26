// 发版链上两个脚本之间的"交接面"。`hardware-acceptance.mjs` 跑完会打印一条 `verify:hardware` 命令，
// 操作者会照抄执行；而它对参数完全错误的调用的唯一保护就是那几条守卫。这两件事都不该靠人记得：
// 前者一旦漂移（校验器改了 flag 名、或驱动打印了一个不存在的 flag），跑完 10 分钟真机才知道；
// 后者一旦失效，就会有人拿着一个只跑了 3 秒的"验收"去发版。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const DRIVER = 'scripts/hardware-acceptance.mjs';
const VERIFIER = 'scripts/verify-hardware-receipt.mjs';

/** 驱动脚本的参数守卫：全部应当拒绝，并且不产生任何产物。 */
const run = (args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [DRIVER, ...args], { encoding: 'utf8' }) };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};

test('驱动脚本对坏参数一律拒绝，而不是安静地跑出一个空验收', () => {
  for (const [args, expect] of [
    [['--seconds', 'abc'], '--seconds'],
    [['--seconds', '3'], '--seconds'],
    [['--seconds', 'Infinity'], '--seconds'],
    [['--seconds', '620', '--poll-ms', '5'], '--poll-ms'],
    // CDP 端口上没有应用时必须是明确报错，不是"跑了个 0 点的验收"。
    [['--seconds', '620', '--port', '1'], '没有响应'],
    [['--seconds', '620', '--exe', 'definitely/not/here.exe', '--port', '1'], '读不到'],
  ]) {
    const { code, out } = run(args);
    assert.notEqual(code, 0, `${args.join(' ')} 应当被拒绝`);
    assert.ok(out.includes(expect), `${args.join(' ')} 的报错里没有 "${expect}"：${out.slice(0, 200)}`);
  }
});

test('驱动打印的 verify:hardware 命令，校验器全部认账', () => {
  const source = readFileSync(DRIVER, 'utf8');
  const printed = source.slice(source.indexOf('npm run verify:hardware'));
  assert.ok(printed.length > 80, '找不到那段"下一步"提示 —— 它被删掉或挪走了，这条检查需要重写');
  const flags = [...new Set([...printed.matchAll(/--([a-z][a-z-]+)/g)].map((m) => m[1]))].filter(
    (f) => f !== 'diagnostics',
  );
  assert.ok(flags.length >= 5, `只解析出 ${flags.length} 个 flag，判为解析器不可信`);
  const probe = run1(VERIFIER, [
    '--csv',
    'does/not/exist.csv',
    ...flags.flatMap((f) => [`--${f}`, f === 'receipt-out' ? 'bench/results/probe-receipt.json' : '1']),
  ]);
  assert.ok(
    !/Unknown option/.test(probe),
    `校验器不认识驱动打印的 flag：${probe.slice(0, 300)}\n驱动打印的：${flags.join(' ')}`,
  );
});

function run1(script, args) {
  try {
    return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
}
