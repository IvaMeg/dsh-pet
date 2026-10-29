/**
 * dsh-pet desktop helper —— 托盘图标的峰谷配色（纯判定，不 require('electron')、不读盘、不建定时器）
 *
 * 为什么单独一份：托盘图标该是哪张图，只取决于两件事——「现在是不是 DeepSeek 的峰时」和「用户开没开
 * 变色」，两条都是规则，而规则必须住在能被 node:test 直接加载的纯模块里，main/tray.js 只接线（同
 * tray-platform.js / dpi-linearization.js）。
 *
 * 峰谷口径的唯一出处是宿主半侧的 src/host/balance/deepseek-common.ts（deepseekPricingTier）：helper
 * 是 CJS、拿不到 TS 模块，只能复制一份，所以 src/host/tray-tint.test.ts 会直接比对两边的判定，
 * 任一边改了窗口时段、另一边没跟就红。
 * @module dsh-pet/runtime/electron-helper/tray-tint
 */
'use strict';

/** 谷图标（默认）：整个 logo 在 16px 下糊成一团，托盘用的是头部特写 */
const ICON_IDLE = 'logo-tray.png';
/** 峰图标：同一张头部特写换个色相，形状不变，只有颜色提示「现在是峰时」 */
const ICON_PEAK = 'logo-tray-peak.png';

/** 时段重算间隔：峰谷边界精确到分钟，30s 取样最坏迟到半分钟，够用且几乎不耗 CPU */
const TIER_TICK_MS = 30 * 1000;

/**
 * DeepSeek 峰谷计价（北京时间，与宿主半侧同一口径）：工作日 9:00–12:00、14:00–18:00 为高峰，
 * 其余为空闲；周末全天按低谷计费。
 * 时区写死 Asia/Shanghai：这是官方计费窗口，跟运行机器的本地时区无关。
 *
 * @param now - 取样时刻，默认当前时间（测试用）。
 * @returns 'peak'（峰）或 'idle'（谷）。
 */
function pricingTier(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23', // 避免午夜被格式化为 24:00。
  }).formatToParts(now);
  const pick = (type) => parts.find((p) => p.type === type)?.value;
  const weekday = pick('weekday');
  const hour = Number(pick('hour'));
  if (weekday === 'Sat' || weekday === 'Sun') return 'idle';
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18) ? 'peak' : 'idle';
}

/**
 * 该用哪张托盘图。
 *
 * @param options - 判定所需的三项状态。
 * @param options.tier - 当前时段（pricingTier 的结果）。
 * @param options.tintable - 本平台是否支持变色（macOS 的模板图是单色遮罩，变不出橙）。
 * @param options.enabled - 用户有没有开「峰谷变色」。
 * @returns 包内 assets/ 下的文件名。
 */
function trayIconFile({ tier, tintable, enabled }) {
  return tier === 'peak' && tintable && enabled ? ICON_PEAK : ICON_IDLE;
}

/**
 * 托盘悬停提示：只在真的会变色时带上时段，免得一个关掉的开关还在提示「峰时」。
 *
 * @param options - 与 trayIconFile 同一组状态。
 * @param options.tier - 当前时段。
 * @param options.tintable - 本平台是否支持变色。
 * @param options.enabled - 用户有没有开「峰谷变色」。
 * @returns 托盘 tooltip 文案。
 */
function trayTooltip({ tier, tintable, enabled }) {
  if (!tintable || !enabled) return 'dsh-pet 桌面宠物';
  return 'dsh-pet 桌面宠物 · ' + (tier === 'peak' ? '峰时' : '谷时');
}

/**
 * 归一化落盘的开关值：只有显式 false 才算关，缺失 / 写坏 / 老版本文件一律按开。
 *
 * 与 main 条目的 trayEnabled 同一取舍——一个坏掉的配置文件不该让功能无声消失。
 *
 * @param raw - JSON.parse 之后的任意值。
 * @returns 开关状态。
 */
function normalizeTintEnabled(raw) {
  return !(raw && raw.tintEnabled === false);
}

module.exports = {
  ICON_IDLE,
  ICON_PEAK,
  TIER_TICK_MS,
  normalizeTintEnabled,
  pricingTier,
  trayIconFile,
  trayTooltip,
};
