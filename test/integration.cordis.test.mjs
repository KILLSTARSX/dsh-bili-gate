// 集成测试：把插件挂到真实的 Cordis 上下文里跑一遍。
//
// 单测里的 fakeCtx 是照 Cordis 的语义手写的，但它证明不了「服务真的能注册」——
// 之前那个坑（ctx.set 没 provide / 属性没 inject）恰恰是单测发现不了、只有在真
// 上下文里才会炸的那类问题。所以这里加载真实的 @deepseek-ai/cordis：
// 找得到就跑，找不到就 skip（别人的机器上不一定装了 DSH）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

function findCordis() {
  const home = os.homedir();
  const guesses = [
    process.env.DSH_CORDIS,
    path.join(home, '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
    path.join(home, '.dsh', 'profiles', 'desktop', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
  ].filter(Boolean);
  return guesses.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

const cordisPath = findCordis();
const skip = cordisPath ? false : '本机没装 @deepseek-ai/cordis，跳过集成测试';

test('真实 Cordis 上下文里能注册 biliEyesGate，卸插件时会注销', { skip }, async (t) => {
  const { Context } = await import(pathToFileURL(cordisPath).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-gate-it-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const calls = [];
  const ctx = new Context();
  ctx.plugin({
    name: 'fake-gateway',
    apply(c) {
      c.provide('typertGateway', {
        async invoke({ namespace, method, args }) {
          calls.push(`${namespace}/${method}`);
          if (method === 'create') return { sessionId: 's-it' };
          if (method === 'rename') return { title: args.request.title };
          if (method === 'prompt') return { accepted: true };
          throw new Error(`unexpected ${namespace}/${method}`);
        },
      });
    },
  });

  const mod = await import('../src/index.js');
  const fiber = ctx.plugin(mod, {
    stateFile: path.join(dir, 'state.json'),
    logFile: path.join(dir, 'gate.log'),
    cwd: 'C:\\work\\bili',
  });

  await settle();
  const gate = ctx.get('biliEyesGate');
  assert.ok(gate, '服务应该挂到上下文上');
  assert.equal((await gate.hello()).protocol, 2);

  assert.deepEqual(await gate.notify({ text: '在吗' }), { ok: true });
  assert.deepEqual(calls, ['session/create', 'session/rename', 'session/prompt']);

  fiber.dispose();
  await settle();
  assert.equal(ctx.get('biliEyesGate'), undefined, '插件卸载后服务要跟着走');
});

async function settle() {
  await new Promise((r) => setTimeout(r, 120));
}
