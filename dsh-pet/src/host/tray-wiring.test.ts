/**
 * 桌面 helper `main/tray.js` 的装配测试：注入假 Electron，真跑 createTray。
 *
 * 为什么值得写：托盘是桌面模式唯一不进浏览器的入口，而它几乎全由「注入的对象」构成（Tray / Menu /
 * nativeImage / app / hostRequest 都是参数）。判定规则住在 tray-tint.js（那里有单测），这里只验接线：
 * 谁被调到、调用顺序、写盘内容、销毁是否清干净——这些错了不会红在规则测试上。
 *
 * 假件：Tray 只记录 setImage/setToolTip/setContextMenu；nativeImage 返回带文件名的假图；
 * setInterval 被替换成"只捕获回调"，因此测试不必等 30s，也不会留下真定时器。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helper = '../../runtime/electron-helper/';
const tint = require(helper + 'tray-tint.js') as TrayTint;
const { createTray } = require(helper + 'main/tray.js') as { createTray: (deps: unknown) => TrayApi };

/** 取最后一个元素：目标环境是 ES2020，用不了 Array.prototype.at。 */
function last<T>(list: T[]): T | undefined {
  return list[list.length - 1];
}

interface TrayTint {
  ICON_IDLE: string;
  ICON_PEAK: string;
  TIER_TICK_MS: number;
  pricingTier: () => 'peak' | 'idle';
}

interface TrayApi {
  start: () => Promise<void>;
  exists: () => boolean;
  destroy: () => void;
}

interface Platform {
  templateImage: boolean;
  leftClickPopsMenu: boolean;
  tintable: boolean;
}

type MenuItem = {
  label?: string;
  type?: string;
  checked?: boolean;
  click?: () => void;
};

/** 假图标：只带文件名，tray.js 只会对它调 isEmpty / resize / setTemplateImage */
class FakeImage {
  readonly file: string;
  constructor(file: string) {
    this.file = file;
  }
  isEmpty(): boolean {
    return false;
  }
  resize(): FakeImage {
    return this;
  }
  setTemplateImage(): void {}
}

/** 假菜单：模板原样留着，测试从里面找菜单项直接点 */
class FakeMenu {
  readonly template: MenuItem[];
  constructor(template: MenuItem[]) {
    this.template = template;
  }
  item(label: string): MenuItem {
    const found = this.template.find((entry) => entry.label === label);
    assert.ok(found, `菜单里没有「${label}」，实际有：${this.template.map((e) => e.label ?? e.type).join(' / ')}`);
    return found;
  }
}

/** 假托盘：记录每次换图/改 tooltip/重设菜单 */
class FakeTray {
  static latest: FakeTray | null = null;
  readonly images: string[] = [];
  readonly tooltips: string[] = [];
  readonly menus: FakeMenu[] = [];
  readonly handlers = new Map<string, () => void>();
  destroyed = false;
  poppedUp = 0;

  constructor(image: FakeImage) {
    this.images.push(image.file);
    FakeTray.latest = this;
  }

  setImage(image: FakeImage): void {
    this.images.push(image.file);
  }
  setToolTip(text: string): void {
    this.tooltips.push(text);
  }
  setContextMenu(menu: FakeMenu): void {
    this.menus.push(menu);
  }
  popUpContextMenu(): void {
    this.poppedUp += 1;
  }
  on(event: string, handler: () => void): void {
    this.handlers.set(event, handler);
  }
  destroy(): void {
    this.destroyed = true;
  }
}

/** 一份「两只宠物、都在主条目里」的成品配置（形状同 hostRequest GET /config 的聚合结果） */
const twoPets = {
  main: {
    pets: [
      { id: 'a', name: '蓝毛', display: 'both' },
      { id: 'b', name: '', display: 'web' },
    ],
  },
};

const desktopPlatform: Platform = { templateImage: false, leftClickPopsMenu: true, tintable: true };

interface HarnessOptions {
  config?: unknown;
  /** 复用的 userData 目录（测跨启动持久化时传同一个） */
  dir?: string;
  /** 预算的 tray-tint.json；undefined = 文件不存在 */
  state?: string;
  canQuit?: boolean;
  platform?: Platform;
}

const createdDirs: string[] = [];

function makeHarness(options: HarnessOptions = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'dsh-pet-tray-'));
  if (!createdDirs.includes(dir)) createdDirs.push(dir);
  const statePath = join(dir, 'tray-tint.json');
  if (options.state !== undefined) writeFileSync(statePath, options.state, 'utf8');
  const config = options.config ?? twoPets;

  const posts: { method: string; url: string; body?: string }[] = [];
  const timers: { ms: number; unrefed: boolean; fire: () => void }[] = [];
  FakeTray.latest = null;

  const deps = {
    app: {
      getPath: (name: string): string => {
        assert.equal(name, 'userData', '开关只能落在 helper 自己的 userData 下');
        return dir;
      },
      quit: () => {},
    },
    Tray: FakeTray,
    Menu: {
      buildFromTemplate: (template: MenuItem[]): FakeMenu => new FakeMenu(template),
    },
    nativeImage: {
      createFromPath: (file: string): FakeImage => new FakeImage(file.replace(/\\/g, '/').split('/').pop() ?? file),
    },
    hostRequest: async (method: string, url: string, body?: string): Promise<{ body?: string }> => {
      posts.push({ method, url, body });
      if (url.endsWith('/config')) return { body: JSON.stringify(config) };
      if (url.endsWith('/quit')) return { body: JSON.stringify({ canQuit: options.canQuit ?? true }) };
      return { body: '{}' };
    },
    callbackUrl: (): string => 'http://127.0.0.1:0/bridge-callback',
    isBridge: true,
    appMode: false,
    petRoute: '/dsh-pet-7340',
    platform: options.platform ?? desktopPlatform,
    helperDir: join('pkg', 'runtime', 'electron-helper'),
  };

  return {
    posts,
    timers,
    dir,
    statePath,
    /** 真跑一次 createTray + start；返回值里的 tray 为 null 表示按配置没建托盘 */
    async start(): Promise<{ api: TrayApi; tray: FakeTray | null }> {
      const api = createTray(deps);
      const realSetInterval = globalThis.setInterval;
      // @ts-expect-error 测试里就是要换掉全局定时器，只捕获回调
      globalThis.setInterval = (callback: () => void, ms: number) => {
        const entry = { ms, unrefed: false, fire: callback };
        timers.push(entry);
        return {
          unref: () => {
            entry.unrefed = true;
          },
        };
      };
      try {
        await api.start();
      } finally {
        globalThis.setInterval = realSetInterval;
      }
      return { api, tray: FakeTray.latest };
    },
    readState(): unknown {
      return JSON.parse(readFileSync(statePath, 'utf8'));
    },
  };
}

/** 当前时段「开着变色」该用哪张图 */
const expectedIcon = (enabled = true): string =>
  tint.pricingTier() === 'peak' && enabled ? tint.ICON_PEAK : tint.ICON_IDLE;

/** 当前时段开着变色时的 tooltip */
const expectedTooltip = (enabled = true): string =>
  enabled ? 'dsh-pet 桌面宠物 · ' + (tint.pricingTier() === 'peak' ? '峰时' : '谷时') : 'dsh-pet 桌面宠物';

/** 取到托盘（没建出来时直接报错，避免下面一堆 undefined 报错） */
const trayOf = (tray: FakeTray | null): FakeTray => {
  assert.ok(tray, '没有建出托盘（pets 或 trayEnabled 的判定可能变了）');
  return tray;
};

describe('createTray', () => {
  test('图标、tooltip、全部宠物条目（含 web 位）与勾选都对', async () => {
    const harness = makeHarness();
    const { tray: built } = await harness.start();
    const tray = trayOf(built);
    assert.deepEqual(tray.images, [expectedIcon()], '初始图标必须按当前时段选');
    assert.deepEqual(tray.tooltips, [expectedTooltip()]);
    const menu = tray.menus[0];
    assert.equal(menu.item('蓝毛').checked, true, 'display=both 应打勾');
    assert.equal(menu.item('b').checked, false, 'display=web 的也要列出来，只是不勾（点一下能送回来）');
    assert.equal(menu.item('峰谷变色').checked, true, '默认开着');
    assert.ok(menu.item('退出'), '宿主允许时必须有退出项');
    const timer = harness.timers[0];
    assert.equal(timer.ms, tint.TIER_TICK_MS, '定时器节拍必须用命名常量');
    assert.equal(timer.unrefed, true, '定时器必须 unref，否则反复启停会攒住事件循环');
  });

  test('点宠物条目发 pet-display：both→web（只翻桌面位，不动浏览器位）', async () => {
    const harness = makeHarness();
    const { tray: built } = await harness.start();
    const tray = trayOf(built);
    tray.menus[0].item('蓝毛').click?.();
    const post = harness.posts.find((entry) => entry.url.endsWith('/pet-display'));
    assert.ok(post, '没有发出 pet-display 请求');
    assert.deepEqual(JSON.parse(post.body ?? '{}'), { id: 'a', display: 'web' });
    assert.equal(last(tray.menus)?.item('蓝毛').checked, false, '切走后这一勾要立刻消失，不用等宿主重启');
  });

  test('trayEnabled === false：不建托盘', async () => {
    const harness = makeHarness({ config: { main: { trayEnabled: false, pets: twoPets.main.pets } } });
    const { tray } = await harness.start();
    assert.equal(tray, null);
  });

  test('配置里没有宠物：不建托盘', async () => {
    const harness = makeHarness({ config: { main: { pets: [] } } });
    const { tray } = await harness.start();
    assert.equal(tray, null);
  });

  test('宿主不允许自退时没有退出项', async () => {
    const harness = makeHarness({ canQuit: false });
    const { tray: built } = await harness.start();
    const labels = trayOf(built).menus[0].template.map((item) => item.label ?? item.type);
    assert.ok(!labels.includes('退出'), `菜单里不该有退出：${labels.join(' / ')}`);
  });
});

describe('createTray · 峰谷变色开关', () => {
  test('翻转：立刻换图 + 改 tooltip + 写盘 + 整份重设菜单', async () => {
    const harness = makeHarness();
    const { tray: built } = await harness.start();
    const tray = trayOf(built);
    tray.menus[0].item('峰谷变色').click?.();

    assert.equal(last(tray.images), tint.ICON_IDLE, '关掉开关后必须是原图，哪怕现在是峰时');
    assert.equal(last(tray.tooltips), 'dsh-pet 桌面宠物', '关掉后不该再提示时段');
    assert.equal(tray.menus.length, 2, '必须重设一次菜单，否则界面上那一勾不刷新');
    assert.equal(last(tray.menus)?.item('峰谷变色').checked, false, '新菜单里这一项必须是未勾状态');
    assert.equal(last(tray.menus)?.item('蓝毛').checked, true, '重设菜单不能弄丢宠物条目本来的勾');
    assert.deepEqual(harness.readState(), { tintEnabled: false }, '开关必须落盘，跨重启记住');
  });

  test('下次启动读回 false：菜单不勾、图标不回橙', async () => {
    const first = makeHarness();
    const { tray: firstBuilt } = await first.start();
    trayOf(firstBuilt).menus[0].item('峰谷变色').click?.();

    const second = makeHarness({ dir: first.dir });
    const { tray: secondBuilt } = await second.start();
    const tray = trayOf(secondBuilt);
    assert.equal(tray.menus[0].item('峰谷变色').checked, false, '读回了 false');
    assert.deepEqual(tray.images, [tint.ICON_IDLE], '关着的开关不能因为重启又亮起来');
    assert.deepEqual(tray.tooltips, ['dsh-pet 桌面宠物']);
  });

  test('再翻回来：恢复变色并写回 true', async () => {
    const harness = makeHarness({ state: JSON.stringify({ tintEnabled: false }) });
    const { tray: built } = await harness.start();
    const tray = trayOf(built);
    last(tray.menus)?.item('峰谷变色').click?.();
    assert.equal(last(tray.menus)?.item('峰谷变色').checked, true, '新菜单里这一项要变成已勾');
    assert.equal(last(tray.images), expectedIcon(true), '翻回开启后按当前时段选图');
    assert.deepEqual(harness.readState(), { tintEnabled: true });
  });

  test('坏文件 / 非布尔值都按开处理，不抛', async () => {
    for (const state of ['not json at all', JSON.stringify({ tintEnabled: 'yes' }), JSON.stringify(null)]) {
      const harness = makeHarness({ state });
      const { tray: built } = await harness.start();
      const tray = trayOf(built);
      assert.equal(tray.menus[0].item('峰谷变色').checked, true, `state=${state} 时应按开处理`);
      assert.equal(tray.images[0], expectedIcon(true));
    }
  });

  test('macOS（模板图变不进去）：没有这个开关项，图标永远原图', async () => {
    const harness = makeHarness({ platform: { ...desktopPlatform, templateImage: true, tintable: false } });
    const { tray: built } = await harness.start();
    const tray = trayOf(built);
    assert.equal(
      tray.menus[0].template.some((item) => item.label === '峰谷变色'),
      false,
      '不支持变色就不该给开关，免得勾了没反应',
    );
    assert.deepEqual(tray.images, [tint.ICON_IDLE]);
    assert.deepEqual(tray.tooltips, ['dsh-pet 桌面宠物']);
  });
});

describe('createTray · 定时与销毁', () => {
  test('时段没变就不碰图标（定时器每 30s 都会响，不能每次都 setImage）', async () => {
    const harness = makeHarness();
    const { tray: built } = await harness.start();
    const tray = trayOf(built);
    const before = tray.images.length;
    harness.timers[0].fire();
    assert.equal(tray.images.length, before, '同一时段内重复调用必须是空操作');
  });

  test('destroy：销毁托盘、清掉定时器、exists 转假', async () => {
    const harness = makeHarness();
    const clearCalls: unknown[] = [];
    const realClearInterval = globalThis.clearInterval;
    globalThis.clearInterval = (handle: unknown): number => {
      clearCalls.push(handle);
      return 0;
    };
    try {
      const { api, tray: built } = await harness.start();
      const tray = trayOf(built);
      assert.equal(api.exists(), true);
      api.destroy();
      assert.equal(tray.destroyed, true);
      assert.equal(clearCalls.length, 1, '必须 clearInterval，否则反复启停会攒住定时器');
      assert.equal(api.exists(), false);
    } finally {
      globalThis.clearInterval = realClearInterval;
    }
  });
});

// 收尾：删掉每个用例造出来的临时 userData 目录
after(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});
