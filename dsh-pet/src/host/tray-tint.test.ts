/**
 * 桌面 helper 托盘「峰谷变色」的判定规则。
 *
 * 背景：托盘图标一直是同一张 logo，用户看不出「现在是不是 DeepSeek 的峰时」（工作日 9:00–12:00、
 * 14:00–18:00 为峰）。本次改动让图标在峰时由蓝变橙，并在右键菜单里给一个「峰谷变色」开关——开关只落
 * helper 自己的 userData 小文件，不写宿主配置、不重启进程。
 *
 * owns only 时段判定与「用哪张图 / 什么 tooltip / 开关怎么归一化」，never 建托盘、读写文件、动 Electron：
 * 那些在 main/tray.js，由 tray-wiring.test.ts 用假 Electron 跑装配。
 *
 * 钉四件事：① 时段判定与宿主半侧 deepseekPricingTier 逐小时一致（两边各有一份实现，任一边改窗口而另一边
 * 没跟就红）；② 只有「峰时 + 平台支持 + 开关打开」三者同时成立才换橙图；③ 开关归一化只认显式 false，
 * 坏文件不能把功能静默关掉；④ 换色要用到的那两张图标真的进了包。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { deepseekPricingTier } from './balance/deepseek-common';

const require = createRequire(import.meta.url);
const helper = '../../runtime/electron-helper/';

/** runtime/cjs 模块的导出形状（Node 侧无类型声明，这里手写一份） */
interface TrayTint {
  ICON_IDLE: string;
  ICON_PEAK: string;
  TIER_TICK_MS: number;
  normalizeTintEnabled: (raw: unknown) => boolean;
  pricingTier: (now?: Date) => 'peak' | 'idle';
  trayIconFile: (options: { tier: string; tintable: boolean; enabled: boolean }) => string;
  trayTooltip: (options: { tier: string; tintable: boolean; enabled: boolean }) => string;
}

const tint = require(helper + 'tray-tint.js') as TrayTint;
const { trayPlatform } = require(helper + 'tray-platform.js') as {
  trayPlatform: (platform: string) => { templateImage: boolean; tintable: boolean };
};

/** 北京时间某刻 → Date。Asia/Shanghai 无夏令时，固定 UTC+8，用 UTC 反推最省事。 */
const bj = (year: number, month: number, day: number, hour: number, minute = 0): Date =>
  new Date(Date.UTC(year, month - 1, day, hour - 8, minute));

/** 一份「峰时 + 能变色 + 开关打开」的基准状态 */
const peakOn = { tier: 'peak', tintable: true, enabled: true };

describe('pricingTier', () => {
  // 2026-10-29 是周四，2026-10-31 周六，2026-11-01 周日
  const thursday = (hour: number, minute = 0): Date => bj(2026, 10, 29, hour, minute);

  test('工作日：四个拐点都含边界 → 9/14 起峰、12/18 转谷', () => {
    assert.equal(tint.pricingTier(thursday(8, 59)), 'idle', '08:59 还没到峰');
    assert.equal(tint.pricingTier(thursday(9, 0)), 'peak', '09:00 整起峰（含边界）');
    assert.equal(tint.pricingTier(thursday(11, 59)), 'peak', '11:59 仍在峰时');
    assert.equal(tint.pricingTier(thursday(12, 0)), 'idle', '12:00 整转谷（含边界）');
    assert.equal(tint.pricingTier(thursday(13, 59)), 'idle', '午休一直是谷');
    assert.equal(tint.pricingTier(thursday(14, 0)), 'peak', '14:00 整起峰（含边界）');
    assert.equal(tint.pricingTier(thursday(17, 59)), 'peak', '17:59 仍在峰时');
    assert.equal(tint.pricingTier(thursday(18, 0)), 'idle', '18:00 整转谷（含边界）');
    assert.equal(tint.pricingTier(thursday(23, 59)), 'idle', '深夜是谷');
  });

  test('午夜：按 00 点算而不是 24 点 → 凌晨不至于落到峰时窗口', () => {
    assert.equal(tint.pricingTier(bj(2026, 10, 30, 0, 0)), 'idle', '零点整');
    assert.equal(tint.pricingTier(bj(2026, 10, 30, 0, 30)), 'idle', '凌晨半小时');
  });

  test('周末：时刻正落在工作日峰时窗口里 → 仍判谷', () => {
    for (const hour of [9, 10, 11, 15, 17]) {
      assert.equal(tint.pricingTier(bj(2026, 10, 31, hour)), 'idle', `周六 ${hour}:00 是谷`);
      assert.equal(tint.pricingTier(bj(2026, 11, 1, hour)), 'idle', `周日 ${hour}:00 是谷`);
    }
  });

  test('与宿主半侧 deepseekPricingTier 逐小时比对 → 连续 7 天 × 24 小时全一致', () => {
    // 两份实现（TS 宿主侧 / CJS helper 侧）都在跑，谁改了计费窗口都必须同步另一份
    const startMs = Date.UTC(2026, 9, 26); // 2026-10-26 周一 00:00 UTC
    for (let day = 0; day < 7; day += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const at = new Date(startMs + (day * 24 + hour) * 3_600_000);
        assert.equal(
          tint.pricingTier(at),
          deepseekPricingTier(at),
          `两侧判定不一致（${at.toISOString()}）：helper 与宿主半侧必须同一口径`,
        );
      }
    }
  });
});

describe('trayIconFile', () => {
  test('三者同时成立：峰时 + 平台能变色 + 开关打开 → 橙图', () => {
    assert.equal(tint.trayIconFile(peakOn), tint.ICON_PEAK);
  });

  test('谷时 → 原图（谷色就是现状的蓝，不改色）', () => {
    assert.equal(tint.trayIconFile({ ...peakOn, tier: 'idle' }), tint.ICON_IDLE);
  });

  test('开关关掉或平台变不了色 → 退回原图', () => {
    assert.equal(tint.trayIconFile({ ...peakOn, enabled: false }), tint.ICON_IDLE, '用户关了开关就不得再变色');
    assert.equal(tint.trayIconFile({ ...peakOn, tintable: false }), tint.ICON_IDLE, 'macOS 模板图变不出橙');
  });

  test('两张图是不同文件 → 否则等于没变色', () => {
    assert.notEqual(tint.ICON_IDLE, tint.ICON_PEAK);
  });

  test('平台开关：macOS 不可变色（模板图）→ 其它平台可', () => {
    assert.equal(trayPlatform('darwin').tintable, false, '模板图是纯 alpha 遮罩，彩色图会被当成形状');
    assert.equal(trayPlatform('win32').tintable, true);
    assert.equal(trayPlatform('linux').tintable, true);
  });
});

describe('trayTooltip', () => {
  test('峰谷都带时段后缀', () => {
    assert.equal(tint.trayTooltip(peakOn), 'dsh-pet 桌面宠物 · 峰时');
    assert.equal(tint.trayTooltip({ ...peakOn, tier: 'idle' }), 'dsh-pet 桌面宠物 · 谷时');
  });

  test('开关关掉 / 平台不支持 → 只显示原名，不谎报时段', () => {
    assert.equal(tint.trayTooltip({ ...peakOn, enabled: false }), 'dsh-pet 桌面宠物');
    assert.equal(tint.trayTooltip({ ...peakOn, tintable: false }), 'dsh-pet 桌面宠物');
  });
});

describe('normalizeTintEnabled', () => {
  test('显式 false → 关', () => {
    assert.equal(tint.normalizeTintEnabled({ tintEnabled: false }), false);
  });

  test('true / 缺失 / 空对象 / 写坏 / null → 一律按开（坏文件不能让功能无声消失）', () => {
    assert.equal(tint.normalizeTintEnabled({ tintEnabled: true }), true);
    assert.equal(tint.normalizeTintEnabled({}), true, '老版本文件里没有这个键');
    assert.equal(tint.normalizeTintEnabled(null), true);
    assert.equal(tint.normalizeTintEnabled(undefined), true);
    assert.equal(tint.normalizeTintEnabled('oops'), true, 'JSON 里放了字符串');
    assert.equal(tint.normalizeTintEnabled({ tintEnabled: 0 }), true, '非布尔值不当作关');
  });
});

test('TIER_TICK_MS：取样间隔为正且不慢于 1 分钟 → 峰谷边界及时反映到图标', () => {
  assert.ok(Number.isInteger(tint.TIER_TICK_MS), '节拍必须是整数毫秒');
  assert.ok(tint.TIER_TICK_MS > 0, '节拍不能为 0');
  assert.ok(tint.TIER_TICK_MS <= 60_000, '取样慢于 1 分钟时，9:00 的变色最坏要等一分钟以上才出现');
});

describe('换色要用的图标', () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as {
    files: string[];
  };

  test('两张图都是能装的 PNG → 缺图时 Electron 拿到空图，托盘直接不可见', () => {
    for (const icon of [tint.ICON_IDLE, tint.ICON_PEAK]) {
      const bytes = readFileSync(fileURLToPath(new URL('../../assets/' + icon, import.meta.url)));
      assert.deepEqual(
        [...bytes.subarray(0, 8)],
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        `assets/${icon} 不是一张 PNG`,
      );
      assert.ok(bytes.length > 1024, `assets/${icon} 太小，可能是空图`);
    }
  });

  test('两张图都在发布清单里 → 否则装到用户机器上就退回单色', () => {
    for (const icon of [tint.ICON_IDLE, tint.ICON_PEAK]) {
      assert.ok(pkg.files.includes('assets/' + icon), `package.json files 缺 assets/${icon}`);
    }
  });
});
