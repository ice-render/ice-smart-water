/**
 * 登录页 —— **整页画布化的登录门**，与外壳同一套设计语言（admin.html 那一套）。
 *
 * 三件事：
 * 1. 它是一层**覆盖画布**（DOM 里的另一个 `<canvas>`，盖在外壳与岛之上）：不透明底色 +
 *    左侧品牌介绍 + 右侧登录卡，登录成功后整层隐藏，应用就露出来了；
 * 2. **不校验账号**：演示应用，"输入任意内容"即可进入 —— 但用户名不能为空，
 *    会把输入的名字带进应用（侧栏底部署名 + 头像 + 欢迎提示）；
 * 3. 登录状态存在 `sessionStorage`：同一个标签页刷新不用重登；侧栏「退出登录」清掉它。
 *
 * 输入控件是 `ICETextField` / `ICEPasswordField`（画布控件）——它们在**聚焦时会挂一个原生
 * input 替身**接键盘输入，所以输入法、选中、退格这些都是浏览器原生行为，不是自己实现的。
 */
import { ICE, token } from 'ice-render';
import {
  ICEAlert,
  ICEButton,
  ICECard,
  ICEHoverManager,
  ICELabel,
  ICEPanel,
  ICEPasswordField,
  ICETag,
  ICEWidget,
  ICETextField,
  getICEFocusManager,
  iceUIManager,
  mountICEAccessibilityMirror,
} from 'ice-web-components';
import {
  CARD_INSET,
  findWidget,
  paragraph,
  sectionHeading,
  type PageContext,
  type Rect,
} from './shell';
import { applyThemeToIce } from './theme';

/** 登录状态存这个 key（sessionStorage，按标签页） */
export const LOGIN_STORAGE_KEY = 'ice-smart-water.user';

export type LoginUser = { name: string; password: string };

export type LoginOptions = {
  canvas: HTMLCanvasElement;
  /** 画布尺寸（与外壳画布一致，由调用方用 measureCanvas() 算） */
  size: { width: number; height: number };
  /** 校验通过后回调（由调用方决定进哪个应用、怎么记状态） */
  onLogin: (user: LoginUser) => void;
  /** 品牌文案 */
  brand?: { name: string; subtitle: string; intro: string; features: string[] };
};

export type LoginHandle = {
  ice: any;
  show: () => void;
  hide: () => void;
  visible: () => boolean;
  /** 提交（按钮点击、Enter、e2e 都走它） */
  submit: () => void;
  /** 清空表单与错误提示（退出登录后调用） */
  reset: () => void;
  /** 当前表单值与错误信息（e2e / 调试用） */
  state: () => { name: string; password: string; error: string };
  /** 按 `state.id` 找控件（与外壳同一个入口，e2e 靠它按坐标点输入框与按钮） */
  find: (id: string) => any;
  destroy: () => void;
};

const DEFAULT_BRAND = {
  name: 'ice-smart-water',
  subtitle: '智慧水务运行控制台',
  intro:
    '面向市政污水厂的工艺设计与运行监视应用：把给排水工艺图、运行工况、水质达标、能耗与负荷放在同一张图上算。',
  features: [
    '工艺流程图：22 个单元 / 24 段管线，可编辑',
    '运行数据：24 小时进出水趋势 + 沿程水量与负荷',
    '符号库：21 种给排水符号 + 运行巡检要点',
    '任意工况：正常运行 / 雨季超越 / 检修停运',
  ],
};

export function mountLogin(options: LoginOptions): LoginHandle {
  const { canvas, size } = options;
  const brand = { ...DEFAULT_BRAND, ...(options.brand || {}) };
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.style.width = `${size.width}px`;
  canvas.style.height = `${size.height}px`;

  const ice = new ICE().init(canvas, { renderMode: 'dirty-rect' });
  // 引擎侧也要跟上（画布底色 / 选中框 / 手柄 / 对齐引导线 / 阴影都走引擎主题）——
  // 每个 ICE 实例都得自己调一次，库不会替我们传播（见 view/theme.ts 的说明）。
  applyThemeToIce(ice);
  new ICEHoverManager(ice).start();
  getICEFocusManager(ice).start();

  /**
   * 文本辅助（`paragraph` / `sectionHeading`）只用到 `ice` 与 `layout` —— 颜色一律走
   * **主题引用**（`token('ui.colors.*')`），所以这里不必、也不该带上主题对象（带上会冻住构造那一刻的色值）。
   */
  const textCtx = { ice, layout: null, toast: () => undefined, notify: () => undefined } as unknown as PageContext;

  // 不透明底色：登录层是覆盖层，底下的应用不能透出来
  ice.addChild(
    new ICEPanel({
      id: 'login-bg',
      left: 0,
      top: 0,
      width: size.width,
      height: size.height,
      radius: 0,
      interactive: false,
      fill: true,
      stroke: false,
      // 底色取主题（原来是写死的 #f8fafc：暗色下会留一块白光板）
      style: { fillStyle: token('ui.colors.background') },
    })
  );

  /* ---------------- 左：品牌与介绍 ---------------- */
  const left = 110;
  const cardWidth = 448;
  const cardHeight = 392;
  const cardX = size.width - left - cardWidth;
  const top = Math.max(140, Math.round((size.height - cardHeight) / 2));

  ice.addChild(
    new ICELabel({
      left,
      top,
      text: '❄',
      style: { fontSize: 34, fillStyle: token('ui.colors.link') },
    })
  );
  ice.addChild(
    new ICELabel({
      left: left + 52,
      top: top + 6,
      text: brand.name,
      style: { fontSize: 30, fontWeight: '700', fillStyle: token('ui.colors.link') },
    })
  );
  ice.addChild(
    new ICELabel({
      left: left + 54,
      top: top + 48,
      text: brand.subtitle,
      style: { fontSize: 16, fillStyle: token('ui.colors.textSecondary') },
    })
  );
  ice.addChild(
    paragraph(textCtx, {
      left: left + 54,
      top: top + 84,
      width: Math.min(520, cardX - left - 90),
      text: brand.intro,
      fontSize: 13,
    })
  );
  // 能力标签（宽度按字数给：ICETag 不会自己量宽）
  let tagX = left + 54;
  brand.features.slice(0, 4).forEach((feature) => {
    const label = feature.split('：')[0];
    const width = label.length * 12 + 26;
    ice.addChild(
      new ICETag({
        left: tagX,
        top: top + 168,
        width,
        height: 26,
        text: label,
        status: 'info',
        variant: 'soft',
      })
    );
    tagX += width + 8;
  });
  ice.addChild(
    paragraph(textCtx, {
      left,
      top: size.height - 96,
      width: Math.min(700, cardX - left - 40),
      text:
        'ICE 家族综合示例：ice-render（画布引擎）· ice-entity-designer（给排水工艺域设计器）· ' +
        'ice-web-components（画布原生控件）· ice-chart（交互式图表）',
      fontSize: 12,
      color: token('ui.colors.textTertiary'),
    })
  );

  /* ---------------- 右：登录卡 ---------------- */
  const card = new ICECard({
    id: 'login-card',
    left: cardX,
    top,
    width: cardWidth,
    height: cardHeight,
    title: '登录',
  });
  ice.addChild(card);

  /** 卡片正文（子节点用**卡片内相对坐标**） */
  const body = new ICEWidget({
    left: 0,
    top: 0,
    width: cardWidth,
    height: cardHeight,
    fill: false,
    stroke: false,
    interactive: false,
  });
  card.addChild(body, false);

  const innerWidth = cardWidth - CARD_INSET * 2;
  const field = (top: number, label: string) => {
    body.addChild(sectionHeading(textCtx, CARD_INSET, top, label), false);
  };

  field(62, '用户名（必填，任意内容）');
  const username = new ICETextField({
    id: 'login-username',
    left: CARD_INSET,
    top: 82,
    width: innerWidth,
    height: 38,
    placeholder: '例如：felix',
    allowClear: true,
  });
  body.addChild(username, false);

  field(134, '密码（不校验，可留空）');
  const password = new ICEPasswordField({
    id: 'login-password',
    left: CARD_INSET,
    top: 154,
    width: innerWidth,
    height: 38,
    placeholder: '任意内容',
    showToggle: true,
  });
  body.addChild(password, false);

  const alert = new ICEAlert({
    id: 'login-alert',
    left: CARD_INSET,
    top: 208,
    width: innerWidth,
    height: 56,
    type: 'info',
    message: '演示环境不校验账号：输入任意用户名即可进入。',
  });
  body.addChild(alert, false);

  const submitButton = new ICEButton({
    id: 'login-submit',
    left: CARD_INSET,
    top: 282,
    width: innerWidth,
    height: 40,
    text: '登 录',
    variant: 'primary',
  });
  body.addChild(submitButton, false);

  const errorLabel = new ICELabel({
    id: 'login-error',
    left: CARD_INSET,
    top: 332,
    width: innerWidth,
    text: '',
    style: { fontSize: 12, fillStyle: token('ui.colors.error') },
  });
  body.addChild(errorLabel, false);

  mountICEAccessibilityMirror(ice, { id: 'login-a11y' });

  /* ---------------- 行为 ---------------- */

  let errorText = '';
  function setError(text: string): void {
    errorText = text;
    errorLabel.setText(text);
    ice.requestRepaint();
  }

  function submit(): void {
    if (!visible()) return;
    const name = username.getValue().trim();
    if (!name) {
      setError('请先输入用户名（任意内容即可）');
      username.focus();
      return;
    }
    setError('');
    options.onLogin({ name, password: password.getValue() });
  }

  submitButton.on('click', submit);

  // 一改输入就把上一次的错误提示撤掉（`ICETextField` 走事件 `change`）
  username.on('change', () => {
    if (errorText) setError('');
  });
  password.on('change', () => {
    if (errorText) setError('');
  });

  // 输入框里按 Enter 直接登录（原生 input 的按键会冒泡到 window，这里挂一层就够）
  const onKeyDown = (event: KeyboardEvent) => {
    if (!visible()) return;
    if (event.key === 'Enter') submit();
  };
  window.addEventListener('keydown', onKeyDown);

  function visible(): boolean {
    return canvas.style.display !== 'none';
  }

  const handle: LoginHandle = {
    ice,
    show(): void {
      canvas.style.display = '';
      ice.requestRepaint();
      // 让用户一进来就能打字：聚焦到用户名（聚焦会挂原生 input 替身）
      requestAnimationFrame(() => {
        // 切回来时清掉上一次的输入，避免"退出登录后还留着上一个人的名字"
        username.clear();
        password.clear();
        username.focus();
      });
    },
    hide(): void {
      canvas.style.display = 'none';
    },
    visible,
    submit,
    reset(): void {
      username.clear();
      password.clear();
      setError('');
    },
    state(): { name: string; password: string; error: string } {
      return { name: username.getValue(), password: password.getValue(), error: errorText };
    },
    find: (id: string) => findWidget(ice, id),
    destroy(): void {
      window.removeEventListener('keydown', onKeyDown);
      if (typeof ice.destroy === 'function') ice.destroy();
    },
  };

  return handle;
}

/* ---------------- 登录状态的存取 ---------------- */

export function readLoginUser(): { name: string } | null {
  try {
    const raw = window.sessionStorage.getItem(LOGIN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.name ? { name: String(parsed.name) } : null;
  } catch (error) {
    return null;
  }
}

export function saveLoginUser(user: { name: string }): void {
  try {
    window.sessionStorage.setItem(LOGIN_STORAGE_KEY, JSON.stringify({ name: user.name }));
  } catch (error) {
    // 隐私模式 / 存储被禁用：登录状态不持久化，不影响本次使用
  }
}

export function clearLoginUser(): void {
  try {
    window.sessionStorage.removeItem(LOGIN_STORAGE_KEY);
  } catch (error) {
    /* 同上 */
  }
}

/** 登录卡片的矩形（纯函数：入口要在建引擎前把覆盖画布摆到位） */
export function loginCardRect(size: { width: number; height: number }, left = 110, cardWidth = 448, cardHeight = 392): Rect {
  const top = Math.max(140, Math.round((size.height - cardHeight) / 2));
  return { left: size.width - left - cardWidth, top, width: cardWidth, height: cardHeight };
}
