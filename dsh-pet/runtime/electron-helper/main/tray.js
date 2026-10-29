'use strict';
/**
 * 系统托盘：桌面模式的显示开关、「峰谷变色」开关与「退出」入口。
 *
 * 托盘是桌面模式唯一不进浏览器的入口——某只宠物改成 web/none 后窗口与右键菜单一起消失，
 * 只有托盘还能把它切回来。
 *
 * owns only 菜单装配与 Electron 接线，never 峰谷规则本身：时段判定、该用哪张图、开关怎么归一化都在
 * tray-tint.js（那里有纯函数单测）。菜单是快照渲染：每次状态变化整份重建，勾才跟得上——Electron 的
 * 勾由菜单对象自己持有，改完不重设就还是旧值。
 * @module dsh-pet/runtime/electron-helper/main/tray
 */

const fs = require('node:fs');
const path = require('node:path');
const { TIER_TICK_MS, normalizeTintEnabled, pricingTier, trayIconFile, trayTooltip } = require('../tray-tint.js');

/**
 * 从成品配置里捞出全部宠物。
 *
 * 形状是 `{ <条目>: <整份配置文档> }`：顶层键不是宠物，宠物在各条目的 pets 数组里（与渲染端同一契约）。
 * 托盘只要 id/name/display，所以不吹条目级字段。
 *
 * @param merged - hostRequest GET /config 的聚合结果。
 * @returns 有 id 的宠物快照数组。
 */
function readPets(merged) {
  return Object.values(merged || {})
    .flatMap((conf) => (conf && Array.isArray(conf.pets) ? conf.pets : []))
    .map((pet) => ({
      id: String((pet && pet.id) || ''),
      name: String((pet && pet.name) || '').trim(), // host 已保证 name 缺失时回落 id
      display: String((pet && pet.display) || ''),
    }))
    .filter((pet) => pet.id);
}

/**
 * 造托盘能力。
 *
 * @param deps.app - Electron app（退出、userData 路径）。
 * @param deps.Tray - Electron Tray 构造器。
 * @param deps.Menu - Electron Menu（模板 → 菜单）。
 * @param deps.nativeImage - Electron nativeImage（图标）。
 * @param deps.hostRequest - 与宿主通信（读配置、改 display、请求退出）。
 * @param deps.callbackUrl - bridge 回调地址（建托盘前要等它就绪）。
 * @param deps.isBridge - 是否由宿主以 bridge 模式拉起。
 * @param deps.appMode - 是否同进程应用模式。
 * @param deps.petRoute - 宠物路由前缀。
 * @param deps.platform - 托盘平台差异（tray-platform.js 的判定结果）。
 * @param deps.helperDir - runtime/electron-helper 的绝对目录（图标在包的 assets/ 下）。
 */
function createTray({
  app,
  Tray,
  Menu,
  nativeImage,
  hostRequest,
  callbackUrl,
  isBridge,
  appMode,
  petRoute,
  platform,
  helperDir,
}) {
  const isDesktopDisplay = (display) => display === 'desktop' || display === 'both';

  /** 翻转「桌面位」：both↔web、desktop↔none——浏览器位保持不动，因此不制造新的单向门 */
  const toggleDisplay = (display) =>
    display === 'both' ? 'web' : display === 'web' ? 'both' : display === 'desktop' ? 'none' : 'desktop';

  let tray = null;
  let trayMenu = null;
  /** 菜单快照：勾从这份算，宠物被切走后由本进程就地改，不等宿主重启 */
  let pets = [];
  /** 峰谷变色开关（用户可在菜单里翻）：落盘在 helper 自己的 userData，跨重启保留 */
  let tintEnabled = true;
  /** 当前图标代表的时段：时段没变就连图都不碰（定时器每 TIER_TICK_MS 调一次） */
  let shownTier = null;
  /** 时段重算定时器：峰谷边界自己会到，菜单保持静态 */
  let tintTimer = null;
  /** 托盘「退出」是否出现：独立应用与手动 start-desktop 流可自退，bridge 下要先问宿主 */
  let canQuit = false;

  /** 写回某只宠物的 display：宿主写完配置会重启本进程，响应可能永远不回（同 sprite.js 的 setPetDisplay） */
  function traySetPetDisplay(id, display) {
    hostRequest('POST', petRoute + '/pet-display', JSON.stringify({ id, display })).catch((e) => {
      console.error('[dsh-pet-desktop-helper] tray pet-display failed:', String(e && e.message ? e.message : e));
    });
  }

  /** 开关落盘位置：helper 自己的 userData（与 primary-scale.json 同一处，不进宿主配置） */
  const tintStatePath = () => path.join(app.getPath('userData'), 'tray-tint.json');

  /** 读开关：文件缺失或写坏都按「开」——一个坏文件不该让功能无声消失（同 trayEnabled 的取舍） */
  function readTintEnabled() {
    try {
      return normalizeTintEnabled(JSON.parse(fs.readFileSync(tintStatePath(), 'utf8')));
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        console.error('[dsh-pet-desktop-helper] tray tint state unreadable:', String(e.message || e));
      }
      return true;
    }
  }

  /** 写开关：失败只影响下次启动的默认值，不阻断本次切换 */
  function saveTintEnabled(enabled) {
    try {
      fs.writeFileSync(tintStatePath(), JSON.stringify({ tintEnabled: enabled }) + '\n', 'utf8');
    } catch (e) {
      console.error('[dsh-pet-desktop-helper] tray tint state unwritable:', String(e && e.message ? e.message : e));
    }
  }

  /** 托盘图标：包内 assets/<file> 缩到 16×16（macOS 要模板图，否则深色菜单栏下看不见） */
  function trayIcon(file) {
    const full = path.join(helperDir, '..', '..', 'assets', file);
    const img = nativeImage.createFromPath(full);
    if (img.isEmpty?.()) {
      // 读不到图标 = 托盘不可见，但菜单逻辑照跑，最难查的一种坏法：必须留下能定位的日志
      console.error('[dsh-pet-desktop-helper] tray icon missing or unreadable: ' + full);
      return img;
    }
    const resized = img.resize({ width: 16, height: 16 });
    if (platform.templateImage) resized.setTemplateImage(true);
    return resized;
  }

  /** 当前时段该用哪张图（判定在 tray-tint.js，这里只把状态喂进去） */
  const iconFile = (tier) => trayIconFile({ tier, tintable: platform.tintable, enabled: tintEnabled });

  /**
   * 按时段换图标与 tooltip。时段没变就什么都不做。
   *
   * @param force - 开关刚被翻时为 true：时段没变，但图标该跟着开关走。
   */
  function applyTrayTint(force) {
    if (!tray) return;
    const tier = pricingTier();
    if (!force && tier === shownTier) return;
    shownTier = tier;
    tray.setImage(trayIcon(iconFile(tier)));
    tray.setToolTip(trayTooltip({ tier, tintable: platform.tintable, enabled: tintEnabled }));
  }

  /** 交给宿主停机：它会先停本进程再退，所以这条请求不用等结果 */
  function quitApp() {
    if (!isBridge || appMode) {
      app.quit();
      return;
    }
    hostRequest('POST', petRoute + '/quit').catch((e) => {
      console.error('[dsh-pet-desktop-helper] tray quit failed:', String(e && e.message ? e.message : e));
    });
  }

  /**
   * 「峰谷变色」开关项。
   *
   * 只换托盘图标配色，不写宿主配置、不重启进程，所以勾、图标与 tooltip 都得自己即时刷。
   * macOS 不提供（模板图是纯 alpha 遮罩，彩色变不进去），见 tray-platform.js 的 tintable。
   */
  function tintItem() {
    return {
      label: '峰谷变色',
      type: 'checkbox',
      checked: tintEnabled,
      click: () => {
        tintEnabled = !tintEnabled;
        saveTintEnabled(tintEnabled);
        applyTrayTint(true);
        renderMenu();
      },
    };
  }

  /**
   * 整份菜单模板。宠物条目含 display 为 web/none 的——它们当前勾是空的，点一下就能送回来，
   * 这是托盘相对宠物右键菜单的增量。勾 = 当前 display 含 desktop/both。
   */
  function buildTemplate() {
    const items = pets.map((pet) => ({
      label: pet.name || pet.id,
      type: 'checkbox',
      checked: isDesktopDisplay(pet.display),
      click: () => {
        const next = toggleDisplay(pet.display);
        pet.display = next; // 先改快照再重设菜单，否则这一勾要等宿主重启才刷新
        traySetPetDisplay(pet.id, next);
        renderMenu();
      },
    }));
    if (platform.tintable) items.push({ type: 'separator' }, tintItem());
    if (canQuit) items.push({ type: 'separator' }, { label: '退出', click: quitApp });
    return items;
  }

  /** 重设菜单：勾由菜单对象自己持有，状态改过就必须整份换掉 */
  function renderMenu() {
    if (!tray) return;
    trayMenu = Menu.buildFromTemplate(buildTemplate());
    tray.setContextMenu(trayMenu);
  }

  /** bridge 下能不能自退由宿主决定：自己退会被当成崩溃按退避重启。探测失败一律按不支持处理 */
  async function probeCanQuit() {
    if (!isBridge || appMode) return true;
    try {
      const resp = await hostRequest('GET', petRoute + '/quit');
      return JSON.parse(resp.body || '{}').canQuit === true;
    } catch (e) {
      console.error('[dsh-pet-desktop-helper] quit capability probe failed:', String(e && e.message ? e.message : e));
      return false;
    }
  }

  async function startTray() {
    try {
      // 请求行要携带回调 URL，而端口在 startBridgeCallback 的 listen 回调里才有值（最多等 2s）
      for (let i = 0; isBridge && !callbackUrl() && i < 100; i += 1) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const resp = await hostRequest('GET', petRoute + '/config');
      const merged = JSON.parse(resp.body || '{}');
      // 托盘开关（main 条目的 trayEnabled）：只有显式 false 才不建，缺失或写坏时保持建，
      // 免得一份老配置或一个错值让托盘无声消失。与下面的 pets 取自同一份成品配置。
      if (merged && merged.main && merged.main.trayEnabled === false) return;
      pets = readPets(merged);
      if (!pets.length) return; // 配置里没有任何宠物：没有可切换的对象，不建托盘
      canQuit = await probeCanQuit();
      if (platform.tintable) tintEnabled = readTintEnabled();
      const tier = pricingTier();
      shownTier = tier;
      tray = new Tray(trayIcon(iconFile(tier)));
      tray.setToolTip(trayTooltip({ tier, tintable: platform.tintable, enabled: tintEnabled }));
      renderMenu();
      // 峰谷边界自己会到（9:00 / 12:00 / 14:00 / 18:00 与周末）：定时重算即可，菜单不必重建
      tintTimer = setInterval(() => applyTrayTint(false), TIER_TICK_MS);
      tintTimer.unref?.();
      // Windows 上 setContextMenu 只接管右键，左键默认什么都不做（macOS 相反：左键即弹菜单）
      if (platform.leftClickPopsMenu) tray.on('click', () => tray.popUpContextMenu());
    } catch (e) {
      console.error('[dsh-pet-desktop-helper] tray init failed:', String(e && e.message ? e.message : e));
    }
  }

  return {
    start: startTray,
    exists: () => tray !== null,
    destroy() {
      if (tintTimer) {
        clearInterval(tintTimer);
        tintTimer = null;
      }
      if (!tray) return;
      try {
        tray.destroy();
      } catch (e) {
        console.error('[dsh-pet-desktop-helper] tray destroy failed:', String(e && e.message ? e.message : e));
      }
      tray = null;
      trayMenu = null;
    },
  };
}

module.exports = { createTray };
