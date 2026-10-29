/**
 * 托盘的平台差异（纯判定，不 require electron）。
 *
 * 规则住在这里、main.js 只接线，是为了能被 node:test 直接加载：macOS 菜单栏有深浅色，图标须按
 * 模板图处理且左键单击即弹菜单；Windows 的 setContextMenu 只接管右键，图标还会被收进溢出面板；
 * Linux 的 click 事件不可靠，原生 GNOME 默认不显示托盘图标。这些差异代码管不了，只能按平台分流。
 * @module dsh-pet/runtime/electron-helper/tray-platform
 */
'use strict';

/**
 * 托盘的平台开关。
 *
 * @param platform - process.platform 的值。
 * @returns templateImage 图标是否按模板图处理；leftClickPopsMenu 左键单击是否需手动弹菜单；
 *   hideDock 是否隐藏 Dock 图标（macOS 专有）；tintable 图标能否改色（见下）。
 */
function trayPlatform(platform) {
  const mac = platform === 'darwin';
  return {
    templateImage: mac,
    leftClickPopsMenu: platform === 'win32',
    hideDock: mac,
    // 模板图是「纯形状的 alpha 遮罩」：系统按菜单栏深浅色自己上色，送进去的彩色图只会被当成形状，
    // 于是峰谷变色的橙永远显示不出来——macOS 上直接不提供这个开关，免得勾了却没反应。
    tintable: !mac,
  };
}

module.exports = { trayPlatform };
