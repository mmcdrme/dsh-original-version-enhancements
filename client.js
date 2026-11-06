window.__ModuleLoader__.load({
  id: '@local/dsh-original-version-enhancements',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Native menu row primitives, when this composition exposes them. */
    let uiPrimitives = null;
    try {
      uiPrimitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch {
      uiPrimitives = null;
    }

    /** Locale namespace owned by this plugin. */
    const NS = 'original-version-enhancements';
    /** Route prefix registered by the Host half. */
    const ROUTE_ROOT = '/plugins/original-version-enhancements';
    const DELETE_ROUTE = `${ROUTE_ROOT}/sessions/delete`;
    /** The four accepted work-details modes, in the same order as Settings. */
    const MODES = ['compact', 'standard', 'detailed', 'verbose'];
    /** Saved values from older generations of the same Host setting. */
    const LEGACY_MODES = { normal: 'detailed', expanded: 'detailed' };
    /** Match ui-chat's default: Desktop starts at Standard, other Web clients at Detailed. */
    const DEFAULT_MODE = 'dshDesktop' in globalThis ? 'standard' : 'detailed';

    /* ------------------------------------------------------------------ */
    /* Feature switches (this browser's view of the plugin page)           */
    /* ------------------------------------------------------------------ */

    const FLAGS_KEY = 'original-version-enhancements.flags.v1';
    const DEFAULT_FLAGS = { stepSwitcher: true, chatManager: true };
    const flagListeners = new Set();

    const readFlags = () => {
      try {
        const raw = JSON.parse(globalThis.localStorage?.getItem(FLAGS_KEY) ?? '{}');
        const flags = raw !== null && typeof raw === 'object' ? raw : {};
        return {
          stepSwitcher: flags.stepSwitcher !== false,
          chatManager: flags.chatManager !== false,
        };
      } catch {
        return { ...DEFAULT_FLAGS };
      }
    };

    let flagState = readFlags();

    const subscribeFlags = (listener) => {
      flagListeners.add(listener);
      return () => { flagListeners.delete(listener); };
    };

    const getFlags = () => flagState;

    const setFlag = (key, value) => {
      flagState = { ...flagState, [key]: value };
      try {
        globalThis.localStorage?.setItem(FLAGS_KEY, JSON.stringify(flagState));
      } catch { /* a blocked storage keeps the switch for this page only */ }
      for (const listener of flagListeners) listener();
    };

    const useFlags = () => React.useSyncExternalStore(subscribeFlags, getFlags, getFlags);

    /* ------------------------------------------------------------------ */
    /* Pending permanent-deletion target, shared by the page and the menu  */
    /* ------------------------------------------------------------------ */

    const deleteListeners = new Set();
    let deleteState = { target: null, busy: false, error: '', code: '' };

    const publishDelete = (patch) => {
      deleteState = { ...deleteState, ...patch };
      for (const listener of deleteListeners) listener();
    };

    const subscribeDelete = (listener) => {
      deleteListeners.add(listener);
      return () => { deleteListeners.delete(listener); };
    };

    const getDelete = () => deleteState;

    const refreshStores = async (ctx) => {
      const tasks = [];
      for (const store of [ctx.sessions, ctx.workspaces]) {
        if (typeof store?.refresh === 'function') {
          tasks.push(Promise.resolve(store.refresh()).catch(() => undefined));
        }
      }
      await Promise.all(tasks);
    };

    /**
     * Read a JSON body, turning an empty or non-JSON answer into a status error.
     * @param response - the fetch response.
     * @returns the parsed JSON payload.
     */
    const readJson = async (response) => {
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        throw Error(`HTTP ${response.status}`);
      }
    };

    /**
     * Ask the Host to remove one session; shared by the page and menu dialogs.
     * @param ctx - the client plugin context.
     * @param target - the session id and display title.
     * @param force - bypass the persistence lease for a pre-loaded session.
     * @returns the outcome and the Host failure code when one is returned.
     */
    const requestDelete = async (ctx, target, force) => {
      try {
        const response = await fetch(DELETE_ROUTE, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-dsh-session-delete-confirmation': 'delete-session',
            ...(force ? { 'x-dsh-session-delete-force': 'force' } : {}),
          },
          body: JSON.stringify({ sessionId: target.id }),
        });
        const body = await readJson(response);
        if (!response.ok || body?.ok !== true) {
          const failure = body?.error ?? {};
          return {
            ok: false,
            error: failure.message || `HTTP ${response.status}`,
            code: typeof failure.code === 'string' ? failure.code : '',
          };
        }
        await refreshStores(ctx);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error), code: '' };
      }
    };

    /* ------------------------------------------------------------------ */
    /* Dictionaries                                                        */
    /* ------------------------------------------------------------------ */

    const zh = {
      group: '工作步骤展示',
      'mode.compact': '简洁',
      'mode.standard': '标准',
      'mode.detailed': '详细',
      'mode.verbose': '完全展开',
      'mode.compact.hint': '简洁 · 仅保留步骤摘要',
      'mode.standard.hint': '标准 · 显示关键步骤',
      'mode.detailed.hint': '详细 · 显示完整工具调用',
      'mode.verbose.hint': '完全展开 · 保留全部历史步骤',
      saving: '正在保存工作步骤展示',
      saveFailed: '工作步骤展示设置保存失败',

      pageTitle: '原版功能增强',
      pageIntro: '把官方界面缺少的快捷操作集中在这里，并可以按需开关。',
      featuresTitle: '功能开关',
      'switch.steps': '工作步骤展示快捷切换',
      'switch.steps.desc': '在会话标题栏与右侧文件面板的「用资源管理器打开」左侧显示四个档位图标。',
      'switch.chat': '聊天记录管理',
      'switch.chat.desc': '启用后，「已归档会话」会作为独立设置页出现，会话右键菜单也会多出「永久删除」。',
      pageHint: '归档会话的搜索、取消归档与永久删除位于「设置 → 已归档会话」。',

      archivesTitle: '已归档会话',
      archivesIntro: '搜索已归档会话的名称、工作区或聊天内容；永久删除只针对已归档且未被宿主加载的本机会话，无法恢复。',
      searchPlaceholder: '搜索名称、工作区或聊天内容',
      searchLabel: '搜索已归档会话',
      searching: '正在搜索归档内容…',
      noRows: '暂无匹配的归档会话',
      noArchives: '当前没有已归档的会话',
      ungrouped: '未分组',
      restore: '取消归档',
      delete: '永久删除',
      menuDelete: '永久删除',
      cancel: '取消',
      confirmDelete: '确认永久删除',
      deleting: '正在删除…',
      restoring: '正在取消归档…',
      dialogTitle: '永久删除会话？',
      dialogDesc: '只删除已归档且未加载的本机会话记录，无法恢复。',
      forceHint: '该会话仍被宿主加载。强制删除会直接移除磁盘上的会话记录；宿主中的该会话随后失效，建议删除后重启 DeepSeek Harness。',
      forceDelete: '强制删除',
      searchMore: '仅显示前 20 条内容匹配，请缩小搜索范围。',
      loadFailed: '聊天记录管理不可用：',
      footnote: '我也是有底线的。',
    };

    const en = {
      group: 'Work details',
      'mode.compact': 'Compact',
      'mode.standard': 'Standard',
      'mode.detailed': 'Detailed',
      'mode.verbose': 'Verbose',
      'mode.compact.hint': 'Compact · summaries only',
      'mode.standard.hint': 'Standard · key steps visible',
      'mode.detailed.hint': 'Detailed · full tool calls',
      'mode.verbose.hint': 'Verbose · every historical step',
      saving: 'Saving work details',
      saveFailed: 'Could not save the work-details setting',

      pageTitle: 'Original Version Enhancements',
      pageIntro: 'Shortcuts the stock interface does not offer, each with its own switch. Switches are stored in this browser.',
      featuresTitle: 'Features',
      'switch.steps': 'Work details quick switch',
      'switch.steps.desc': 'Shows the four work-details icons left of Open in File Explorer in the session header and the file panel.',
      'switch.chat': 'Chat history manager',
      'switch.chat.desc': 'Adds a separate Archived sessions settings page and a permanent-delete row to the session context menu.',
      pageHint: 'Archive search, unarchive and permanent deletion live in Settings → Archived sessions.',

      archivesTitle: 'Archived sessions',
      archivesIntro: 'Search archived session names, workspaces, or chat content. Permanent deletion only applies to unloaded archived local sessions and cannot be undone.',
      searchPlaceholder: 'Search names, workspaces or messages',
      searchLabel: 'Search archived sessions',
      searching: 'Searching archived messages…',
      noRows: 'No matching archived sessions',
      noArchives: 'No archived sessions',
      ungrouped: 'Ungrouped',
      restore: 'Unarchive',
      delete: 'Delete permanently',
      menuDelete: 'Delete permanently',
      cancel: 'Cancel',
      confirmDelete: 'Confirm permanent deletion',
      deleting: 'Deleting…',
      restoring: 'Unarchiving…',
      dialogTitle: 'Permanently delete session?',
      dialogDesc: 'Only an unloaded, archived local session can be deleted. This cannot be undone.',
      forceHint: 'The session is still loaded by the Host. Forcing removes its disk record anyway; the in-memory session becomes invalid, so restart DeepSeek Harness afterwards.',
      forceDelete: 'Force delete',
      searchMore: 'Showing the first 20 content matches. Narrow your search.',
      loadFailed: 'Chat history manager unavailable: ',
      footnote: 'Original Version Enhancements · the chat history part is adapted from dsh-chat-manager (MIT).',
    };

    /* ------------------------------------------------------------------ */
    /* Styles                                                              */
    /* ------------------------------------------------------------------ */

    const CSS = `
      .tqs-root {
        box-sizing: border-box;
        display: inline-flex;
        flex: none;
        align-self: center;
        align-items: stretch;
        height: 24px;
        overflow: hidden;
        border: .5px solid var(--dsw-alias-border-l2);
        border-radius: 8px;
        background: transparent;
        color: var(--dsw-alias-label-secondary);
      }
      .tqs-root[data-error="true"] { border-color: var(--dsw-alias-state-error-primary); }
      .tqs-button {
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 23px;
        padding: 0;
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        position: relative;
        -webkit-tap-highlight-color: transparent;
      }
      .tqs-button + .tqs-button::before {
        content: "";
        position: absolute;
        left: 0;
        top: 5px;
        bottom: 5px;
        border-left: .5px solid var(--dsw-alias-border-l1);
      }
      .tqs-button:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
      .tqs-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
      .tqs-button[aria-pressed="true"] {
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-layer-2);
        box-shadow: inset 0 -2px 0 var(--dsw-alias-brand-primary);
      }
      .tqs-sr {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
        border: 0;
      }

      .ove-page { display: grid; gap: 20px; color: var(--dsw-alias-label-primary); }
      .ove-head { display: grid; gap: 6px; }
      .ove-title { margin: 0; font-size: 18px; line-height: 26px; font-weight: 600; }
      .ove-intro { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary); }
      .ove-group { display: grid; gap: 8px; }
      .ove-group-title { margin: 0; font-size: 14px; line-height: 22px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
      .ove-card {
        border: .5px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-layer-2);
        border-radius: 12px;
        padding: 0 14px;
      }
      .ove-row { display: flex; align-items: flex-start; gap: 16px; padding: 14px 0; }
      .ove-row + .ove-row { border-top: .5px solid var(--dsw-alias-border-l1); }
      .ove-row-text { flex: 1 1 auto; min-width: 0; display: grid; gap: 2px; }
      .ove-row-title { font-size: 14px; line-height: 22px; }
      .ove-row-desc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
      .ove-switch {
        box-sizing: border-box;
        flex: none;
        width: 36px;
        height: 20px;
        margin-top: 1px;
        padding: 2px;
        border: 0;
        border-radius: 999px;
        background: var(--dsw-alias-border-l2);
        cursor: pointer;
        transition: background .15s ease;
        position: relative;
      }
      .ove-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
      .ove-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .ove-switch-thumb {
        display: block;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: #fff;
        transform: translateX(0);
        transition: transform .15s ease;
        box-shadow: 0 1px 2px rgba(0, 0, 0, .25);
      }
      .ove-switch[aria-checked="true"] .ove-switch-thumb { transform: translateX(16px); }
      .ove-hint { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
      .ove-chat { display: grid; gap: 12px; }
      .ove-search {
        box-sizing: border-box;
        width: 100%;
        height: 36px;
        padding: 0 14px;
        border-radius: 8px;
        border: 1px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-base);
        color: inherit;
        font-size: 14px;
      }
      .ove-search:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
      .ove-muted { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary); }
      .ove-error { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-state-error-primary); }
      .ove-row-item { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 14px 0; }
      .ove-row-item + .ove-row-item { border-top: .5px solid var(--dsw-alias-border-l1); }
      .ove-item-text { flex: 1 1 180px; min-width: 0; display: grid; gap: 2px; }
      .ove-item-title { font-size: 14px; line-height: 22px; overflow-wrap: anywhere; }
      .ove-item-sub { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
      .ove-snippet { margin: 4px 0 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
      .ove-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-left: auto; }
      .ove-btn {
        box-sizing: border-box;
        height: 28px;
        padding: 0 12px;
        border-radius: 7px;
        border: .5px solid var(--dsw-alias-border-l2);
        background: transparent;
        color: var(--dsw-alias-label-primary);
        font-size: 13px;
        cursor: pointer;
      }
      .ove-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
      .ove-btn:disabled { opacity: .5; cursor: default; }
      .ove-btn-danger { color: var(--dsw-alias-state-error-primary); }
      .ove-footnote { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }

      .ove-menu-item {
        display: flex;
        align-items: center;
        gap: 7px;
        width: 100%;
        box-sizing: border-box;
        padding: 6px 8px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: var(--dsw-alias-state-error-primary);
        font-size: 13px;
        line-height: 20px;
        text-align: left;
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
      }
      .ove-menu-item:hover, .ove-menu-item:focus-visible {
        background: var(--dsw-alias-bg-layer-2);
        outline: none;
      }
      .ove-menu-icon { flex: none; display: block; }

      .ove-overlay {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(0, 0, 0, .4);
        pointer-events: auto;
      }
      .ove-overlay-top { z-index: 2147483000; }
      .ove-dialog {
        box-sizing: border-box;
        width: min(420px, 100%);
        display: grid;
        gap: 12px;
        padding: 20px;
        border-radius: 14px;
        border: .5px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
        box-shadow: 0 12px 40px rgba(0, 0, 0, .35);
      }
      .ove-dialog-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; }
      .ove-dialog-desc { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
      .ove-dialog-target {
        margin: 0;
        padding: 8px 10px;
        border-radius: 8px;
        background: var(--dsw-alias-bg-base);
        font-size: 13px;
        line-height: 20px;
        overflow-wrap: anywhere;
      }
      .ove-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
      .ove-warn { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-state-warning-primary, #b45309); }
    `;

    /* ------------------------------------------------------------------ */
    /* Work-details switcher                                               */
    /* ------------------------------------------------------------------ */

    /**
     * Resolve the saved Host value into one of the four offered modes.
     * @param value - raw transcriptView from the Host settings document.
     * @returns the normalized visible mode.
     */
    function normalizeMode(value) {
      if (value === 'normal' || value === 'expanded') return LEGACY_MODES[value];
      return MODES.includes(value) ? value : DEFAULT_MODE;
    }

    const SVG_PROPS = {
      viewBox: '0 0 16 16',
      width: 14,
      height: 14,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
      style: { display: 'block', pointerEvents: 'none' },
    };

    /**
     * Four original glyphs: a collapsed card, a plain list, a branching tree,
     * and a fully expanded branching tree.
     * @param props - the work-details mode to draw.
     * @returns the inline SVG.
     */
    function ModeIcon({ mode }) {
      let glyph;
      if (mode === 'compact') {
        glyph = [
          h('rect', { key: 'card', x: 2.5, y: 4.25, width: 11, height: 7.5, rx: 2.25 }),
          h('path', { key: 'lines', d: 'M5.25 6.75h4M5.25 9.25h5.5' }),
        ];
      } else if (mode === 'standard') {
        glyph = [
          h('path', { key: 'rows', d: 'M2.75 4.5h10.5M2.75 8h10.5M2.75 11.5h7' }),
        ];
      } else if (mode === 'detailed') {
        glyph = [
          h('path', { key: 'trunk', d: 'M2.75 3.25v9.5' }),
          h('path', { key: 'branches', d: 'M2.75 4.5h2M2.75 8h2M2.75 11.5h2' }),
          h('path', { key: 'leaves', d: 'M6.25 4.5h7.5M6.25 8h5M6.25 11.5h7' }),
          h('circle', { key: 'n1', cx: 2.75, cy: 4.5, r: .8, fill: 'currentColor', stroke: 'none' }),
          h('circle', { key: 'n2', cx: 2.75, cy: 8, r: .8, fill: 'currentColor', stroke: 'none' }),
          h('circle', { key: 'n3', cx: 2.75, cy: 11.5, r: .8, fill: 'currentColor', stroke: 'none' }),
        ];
      } else {
        glyph = [
          h('path', { key: 'trunk', d: 'M2.5 2.75v10.5' }),
          h('path', { key: 'branches', d: 'M2.5 4.5h2M2.5 8h2M2.5 11.5h2' }),
          h('path', { key: 'leaves', d: 'M6.5 4.5h7M6.5 8h7M6.5 11.5h7' }),
          h('path', { key: 'detail', d: 'M9.75 6.25h3.75M9.75 9.75h3.75' }),
          h('circle', { key: 'n1', cx: 2.5, cy: 4.5, r: .8, fill: 'currentColor', stroke: 'none' }),
          h('circle', { key: 'n2', cx: 2.5, cy: 8, r: .8, fill: 'currentColor', stroke: 'none' }),
          h('circle', { key: 'n3', cx: 2.5, cy: 11.5, r: .8, fill: 'currentColor', stroke: 'none' }),
        ];
      }
      return h('svg', SVG_PROPS, glyph);
    }

    /**
     * Four compact mode buttons placed beside the workspace opener.
     * @param props - injected Host form and translator.
     * @returns the segmented control, or nothing while the switch is off.
     */
    function WorkStepsQuickSwitch({ form, t }) {
      const tr = typeof t === 'function' ? t : (key) => key;
      const flags = useFlags();
      const readMode = () => normalizeMode(form?.getSnapshot?.().value?.transcriptView);
      const [live, setLive] = React.useState(readMode);
      const [pending, setPending] = React.useState(null);
      const [failed, setFailed] = React.useState(false);
      const request = React.useRef(0);

      React.useEffect(() => {
        if (form === undefined || typeof form.subscribe !== 'function') return undefined;
        const sync = () => setLive(readMode());
        sync();
        return form.subscribe(sync);
      }, [form]);

      React.useEffect(() => {
        if (pending !== null && live === pending) setPending(null);
      }, [live, pending]);

      if (!flags.stepSwitcher) return null;

      const selected = pending ?? live;

      const choose = (mode) => {
        if (form === undefined || typeof form.set !== 'function') {
          setFailed(true);
          return;
        }
        if (mode === selected && !failed) return;
        setFailed(false);
        const current = ++request.current;
        setPending(mode);
        let result;
        try {
          result = form.set('transcriptView', mode);
        } catch (_error) {
          setPending(null);
          setFailed(true);
          return;
        }
        Promise.resolve(result).then((accepted) => {
          if (request.current !== current) return;
          if (accepted === false) {
            setPending(null);
            setFailed(true);
          }
        }).catch(() => {
          if (request.current !== current) return;
          setPending(null);
          setFailed(true);
        });
      };

      return h(React.Fragment, null,
        h('style', { key: 'styles', 'data-plugin-css': NS }, CSS),
        h('div', {
          className: 'tqs-root',
          role: 'group',
          'aria-label': tr('group'),
          'aria-busy': pending !== null,
          'data-error': failed ? 'true' : undefined,
          title: failed ? tr('saveFailed') : tr('group'),
        },
          MODES.map((mode) => h('button', {
            key: mode,
            type: 'button',
            className: 'tqs-button',
            'aria-pressed': selected === mode,
            'aria-label': tr(`mode.${mode}`),
            title: tr(`mode.${mode}.hint`),
            onClick: () => choose(mode),
          }, h(ModeIcon, { mode }))),
          h('span', {
            className: 'tqs-sr',
            role: 'status',
            'aria-live': 'polite',
          }, failed ? tr('saveFailed') : pending !== null ? tr('saving') : ''),
        ),
      );
    }

    /* ------------------------------------------------------------------ */
    /* Plugin page: the two feature switches                               */
    /* ------------------------------------------------------------------ */

    /**
     * Feature switches; the archive surface now has its own settings entry.
     * @param props - injected translator.
     * @returns the plugin page.
     */
    function PluginPage({ t }) {
      const tr = typeof t === 'function' ? t : (key) => key;
      const flags = useFlags();

      const toggle = (key) => setFlag(key, !flags[key]);

      return h(React.Fragment, null,
        h('style', { key: 'styles', 'data-plugin-css': `${NS}-page` }, CSS),
        h('div', { className: 'ove-page' },
          h('div', { className: 'ove-head' },
            h('h1', { className: 'ove-title' }, tr('pageTitle')),
            h('p', { className: 'ove-intro' }, tr('pageIntro'))),

          h('div', { className: 'ove-group' },
            h('h2', { className: 'ove-group-title' }, tr('featuresTitle')),
            h('div', { className: 'ove-card' },
              h('div', { className: 'ove-row' },
                h('div', { className: 'ove-row-text' },
                  h('div', { className: 'ove-row-title' }, tr('switch.steps')),
                  h('div', { className: 'ove-row-desc' }, tr('switch.steps.desc'))),
                h('button', {
                  type: 'button',
                  className: 'ove-switch',
                  role: 'switch',
                  'aria-checked': flags.stepSwitcher,
                  'aria-label': tr('switch.steps'),
                  onClick: () => toggle('stepSwitcher'),
                }, h('span', { className: 'ove-switch-thumb' }))),

              h('div', { className: 'ove-row' },
                h('div', { className: 'ove-row-text' },
                  h('div', { className: 'ove-row-title' }, tr('switch.chat')),
                  h('div', { className: 'ove-row-desc' }, tr('switch.chat.desc'))),
                h('button', {
                  type: 'button',
                  className: 'ove-switch',
                  role: 'switch',
                  'aria-checked': flags.chatManager,
                  'aria-label': tr('switch.chat'),
                  onClick: () => toggle('chatManager'),
                }, h('span', { className: 'ove-switch-thumb' }))))),

          h('p', { className: 'ove-hint' }, tr('pageHint')),
          h('p', { className: 'ove-footnote' }, tr('footnote'))),
      );
    }

    /* ------------------------------------------------------------------ */
    /* Archived sessions page                                              */
    /* ------------------------------------------------------------------ */

    /**
     * Archived-session search, unarchive, and permanent deletion.
     * @param props - standard settings props, translator, and the plugin context.
     * @returns the archived sessions page.
     */
    function ArchivedPage({ useSessions, useWorkspaces, t, ctx }) {
      const tr = typeof t === 'function' ? t : (key) => key;
      const sessions = useSessions((s) => s);
      const workspaces = useWorkspaces((s) => s);

      const [query, setQuery] = React.useState('');
      const [matches, setMatches] = React.useState(new Map());
      const [hasMore, setHasMore] = React.useState(false);
      const [searching, setSearching] = React.useState(false);
      const [searchError, setSearchError] = React.useState('');
      const [busy, setBusy] = React.useState(null);
      const [actionError, setActionError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [pending, setPending] = React.useState(null);
      const [deleteBusy, setDeleteBusy] = React.useState(false);
      const [deleteError, setDeleteError] = React.useState('');
      const [deleteCode, setDeleteCode] = React.useState('');

      const normalized = query.trim();

      React.useEffect(() => {
        if (normalized.length === 0) {
          setMatches(new Map());
          setHasMore(false);
          setSearching(false);
          return undefined;
        }
        const controller = new AbortController();
        const timer = setTimeout(async () => {
          setSearching(true);
          setSearchError('');
          try {
            const response = await fetch(`${ROUTE_ROOT}/archives/search`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ query: normalized }),
              signal: controller.signal,
            });
            const body = await readJson(response);
            if (!response.ok || body?.ok !== true) {
              throw Error(body?.error?.message || `HTTP ${response.status}`);
            }
            if (controller.signal.aborted) return;
            const next = new Map();
            for (const item of body.value?.items ?? []) next.set(item.sessionId, item.snippet);
            setMatches(next);
            setHasMore(body.value?.hasMore === true);
          } catch (error) {
            if (!controller.signal.aborted) setSearchError(String(error?.message ?? error));
          } finally {
            if (!controller.signal.aborted) setSearching(false);
          }
        }, 250);
        return () => { clearTimeout(timer); controller.abort(); };
      }, [normalized]);

      const archivedIds = Array.isArray(workspaces?.archivedSessionIds) ? workspaces.archivedSessionIds : [];
      const owners = new Map();
      for (const workspace of workspaces?.items ?? []) {
        for (const id of workspace.sessionIds ?? []) owners.set(id, workspace.title);
      }
      const rows = [...archivedIds].reverse().map((id) => ({
        id,
        title: sessions?.byId?.[id]?.displayTitle || id,
        workspace: owners.get(id) || tr('ungrouped'),
        snippet: matches.get(id),
      })).filter((row) => normalized.length === 0
        || `${row.title} ${row.workspace}`.toLowerCase().includes(normalized.toLowerCase())
        || row.snippet !== undefined);

      const restore = async (row) => {
        if (busy !== null) return;
        setBusy(row.id);
        setActionError('');
        setNotice('');
        try {
          const service = ctx.workspaces;
          if (typeof service?.unarchiveSession !== 'function') {
            throw new Error(tr('loadFailed') + 'workspaces.unarchiveSession');
          }
          await service.unarchiveSession(row.id);
          setNotice(`${tr('restore')} · ${row.title}`);
          await refreshStores(ctx);
        } catch (error) {
          setActionError(String(error?.message ?? error));
        } finally {
          setBusy(null);
        }
      };

      const openDelete = (row) => {
        setPending({ id: row.id, title: row.title });
        setDeleteError('');
        setDeleteCode('');
        setActionError('');
        setNotice('');
      };

      const cancelDelete = () => {
        if (deleteBusy) return;
        setPending(null);
        setDeleteError('');
        setDeleteCode('');
      };

      const confirmDelete = async (force) => {
        if (pending === null || deleteBusy) return;
        setDeleteBusy(true);
        setDeleteError('');
        const result = await requestDelete(ctx, pending, force);
        setDeleteBusy(false);
        if (result.ok) {
          setNotice(`${tr('delete')} · ${pending.title}`);
          setPending(null);
          setDeleteCode('');
        } else {
          setDeleteError(result.error);
          setDeleteCode(result.code);
        }
      };

      return h(React.Fragment, null,
        h('style', { key: 'styles', 'data-plugin-css': `${NS}-archives` }, CSS),
        h('div', { className: 'ove-page' },
          h('div', { className: 'ove-head' },
            h('h1', { className: 'ove-title' }, tr('archivesTitle')),
            h('p', { className: 'ove-intro' }, tr('archivesIntro'))),

          h('input', {
            type: 'search',
            className: 'ove-search',
            value: query,
            maxLength: 500,
            placeholder: tr('searchPlaceholder'),
            'aria-label': tr('searchLabel'),
            onChange: (event) => { setQuery(event.target.value); setActionError(''); },
          }),
          searching && h('p', { className: 'ove-muted', role: 'status' }, tr('searching')),
          hasMore && h('p', { className: 'ove-muted', role: 'status' }, tr('searchMore')),
          searchError && h('p', { className: 'ove-error', role: 'alert' }, `${tr('loadFailed')}${searchError}`),
          actionError && h('p', { className: 'ove-error', role: 'alert' }, actionError),
          notice && h('p', { className: 'ove-muted', role: 'status' }, notice),
          rows.length === 0 && h('p', { className: 'ove-muted' },
            archivedIds.length === 0 ? tr('noArchives') : tr('noRows')),
          rows.length > 0 && h('div', { className: 'ove-card' },
            rows.map((row) => h('div', { key: row.id, className: 'ove-row-item' },
              h('div', { className: 'ove-item-text' },
                h('div', { className: 'ove-item-title' }, row.title),
                h('div', { className: 'ove-item-sub' }, row.workspace),
                row.snippet !== undefined && h('p', { className: 'ove-snippet' }, row.snippet)),
              h('div', { className: 'ove-actions' },
                h('button', {
                  type: 'button',
                  className: 'ove-btn',
                  disabled: busy !== null,
                  onClick: () => restore(row),
                }, busy === row.id ? tr('restoring') : tr('restore')),
                h('button', {
                  type: 'button',
                  className: 'ove-btn ove-btn-danger',
                  disabled: busy !== null,
                  onClick: () => {
                    openDelete(row);
                  },
                }, tr('delete')))))),

          h('p', { className: 'ove-footnote' }, tr('footnote'))),

        // Rendered inside the settings panel so the confirmation stays above
        // the page instead of falling behind the settings modal.
        pending !== null && h(DeleteConfirm, {
          t,
          target: pending,
          busy: deleteBusy,
          error: deleteError,
          code: deleteCode,
          onCancel: cancelDelete,
          onConfirm: confirmDelete,
          overlayClass: 'ove-overlay-top',
        }),
      );
    }

    /* ------------------------------------------------------------------ */
    /* Session context menu: permanent deletion                            */
    /* ------------------------------------------------------------------ */

    const TrashIcon = () => h('svg', {
      viewBox: '0 0 16 16',
      width: 14,
      height: 14,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
      className: 'ove-menu-icon',
      style: { display: 'block', pointerEvents: 'none' },
    },
      h('path', { d: 'M3 4.5h10M6.5 4.5V3.25h3V4.5M4.5 4.5l.6 8.25h5.8l.6-8.25' }),
      h('path', { d: 'M6.75 7v3.5M9.25 7v3.5' }));

    /**
     * Right-click row action: delete one session permanently.
     * @param props - owner props, menu hook, translator.
     * @returns the menu row.
     */
    function SessionDeleteMenuItem({ sessionId, displayTitle, useMenuOpenState, t }) {
      const tr = typeof t === 'function' ? t : (key) => key;
      const [, closeMenu] = useMenuOpenState();
      const label = tr('menuDelete');

      const select = () => {
        closeMenu(false);
        publishDelete({ target: { id: sessionId, title: displayTitle || sessionId }, busy: false, error: '', code: '' });
      };

      if (uiPrimitives?.MenuItemButton) {
        return h(uiPrimitives.MenuItemButton, {
          danger: true,
          icon: uiPrimitives.IconTrashOutlineRegular
            ? h(uiPrimitives.IconTrashOutlineRegular, {})
            : undefined,
          onSelect: select,
        }, label);
      }

      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'ove-menu-item',
        onClick: select,
      }, h(TrashIcon), h('span', null, label));
    }

    /* ------------------------------------------------------------------ */
    /* Confirmation dialog (frame overlay)                                 */
    /* ------------------------------------------------------------------ */

    /**
     * Shared permanent-deletion confirmation.
     * @param props - injected translator and the plugin context.
     * @returns the dialog, or nothing while no target is pending.
     */
    /**
     * Confirmation card shared by the archive page and the session menu.
     * @param props - target, pending state, handlers, translator, overlay class.
     * @returns the confirmation overlay.
     */
    function DeleteConfirm({ t, target, busy, error, code, onCancel, onConfirm, overlayClass }) {
      const tr = typeof t === 'function' ? t : (key) => key;
      const cancelRef = React.useRef(null);
      const canForce = code === 'lifecycle-unavailable' || code === 'lifecycle-error';

      React.useEffect(() => {
        cancelRef.current?.focus?.();
      }, []);

      React.useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape' && !busy) onCancel(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [busy, onCancel]);

      return h('div', {
        className: `ove-overlay ${overlayClass ?? ''}`.trim(),
        onMouseDown: (event) => { if (event.target === event.currentTarget) onCancel(); },
      },
        h('div', {
          className: 'ove-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': tr('dialogTitle'),
        },
          h('h2', { className: 'ove-dialog-title' }, tr('dialogTitle')),
          h('p', { className: 'ove-dialog-desc' }, tr('dialogDesc')),
          h('p', { className: 'ove-dialog-target' }, target.title),
          error && h('p', { className: 'ove-error', role: 'alert' }, error),
          canForce && h('p', { className: 'ove-warn' }, tr('forceHint')),
          h('div', { className: 'ove-dialog-actions' },
            h('button', {
              type: 'button',
              className: 'ove-btn',
              ref: cancelRef,
              disabled: busy,
              onClick: onCancel,
            }, tr('cancel')),
            canForce && h('button', {
              type: 'button',
              className: 'ove-btn ove-btn-danger',
              disabled: busy,
              onClick: () => onConfirm(true),
            }, tr('forceDelete')),
            !canForce && h('button', {
              type: 'button',
              className: 'ove-btn ove-btn-danger',
              disabled: busy,
              onClick: () => onConfirm(false),
            }, busy ? tr('deleting') : tr('confirmDelete')))));
    }

    /**
     * Session-menu deletion confirmation bound to the shared pending target.
     * @param props - injected translator and the plugin context.
     * @returns the confirmation overlay, or nothing while no target is pending.
     */
    function DeleteDialog({ t, ctx }) {
      const state = React.useSyncExternalStore(subscribeDelete, getDelete, getDelete);
      if (state.target === null) return null;

      const cancel = () => { if (!deleteState.busy) publishDelete({ target: null, error: '', code: '' }); };
      const confirm = async (force) => {
        const target = deleteState.target;
        if (target === null || deleteState.busy) return;
        publishDelete({ busy: true, error: '' });
        const result = await requestDelete(ctx, target, force);
        if (result.ok) publishDelete({ target: null, busy: false, error: '', code: '' });
        else publishDelete({ busy: false, error: result.error, code: result.code });
      };

      return h(DeleteConfirm, {
        t,
        target: state.target,
        busy: state.busy,
        error: state.error,
        code: state.code,
        onCancel: cancel,
        onConfirm: confirm,
      });
    }

    /* ------------------------------------------------------------------ */
    /* Plugin wiring                                                       */
    /* ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale', 'configForms', 'workspaces', 'sessions'],
      apply(ctx) {
        const text = (key) => ctx.locale.getSnapshot().active === 'zh' ? (zh[key] ?? key) : (en[key] ?? key);
        const translator = (key) => text(key);

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'original-version-enhancements: dictionaries');

        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'original-version-enhancements',
          order: 22,
          label: () => text('pageTitle'),
          inject: () => ({ t: translator }),
        }, PluginPage)), 'original-version-enhancements: plugin page');

        // The archive page, the session menu row, and the dialog exist only
        // while the chat-manager switch is on; toggling disposes them live.
        ctx.effect(() => {
          let disposers = [];
          const sync = () => {
            const enabled = getFlags().chatManager;
            if (enabled && disposers.length === 0) {
              disposers = [
                ctx.slots.inject('settings.section', () => ctx.slots.register({
                  name: 'settings.section',
                  id: 'archived-sessions',
                  order: 25,
                  label: () => text('archivesTitle'),
                  inject: () => ({ t: translator, ctx }),
                }, ArchivedPage)),
                ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
                  name: 'sidebar.workspaces.session.menu.item',
                  id: 'original-version-enhancements.delete',
                  order: 500,
                  inject: () => ({ t: translator, ctx }),
                }, SessionDeleteMenuItem)),
                ctx.slots.inject('shell.overlay', () => ctx.slots.register({
                  name: 'shell.overlay',
                  id: 'original-version-enhancements.delete-dialog',
                  inject: () => ({ t: translator, ctx }),
                }, DeleteDialog)),
              ];
            } else if (!enabled && disposers.length > 0) {
              for (const dispose of disposers) dispose();
              disposers = [];
            }
          };
          const unsubscribe = subscribeFlags(sync);
          sync();
          return () => {
            unsubscribe();
            for (const dispose of disposers) dispose();
            disposers = [];
          };
        }, 'original-version-enhancements: chat manager surfaces');

        ctx.effect(() => ctx.configForms.whileServed(['ui-chat'], () => {
          const form = ctx.configForms.get('ui-chat');
          const register = (slot, order) => ctx.slots.inject(slot, () => ctx.slots.register({
            name: slot,
            id: 'original-version-enhancements',
            order,
            locale: NS,
            inject: () => ({ form }),
          }, WorkStepsQuickSwitch));
          const disposers = [
            register('conversation.session.header.utilities', -20),
            register('sidebar.right.tab.files.actions', -10),
          ];
          return () => {
            for (const dispose of disposers) dispose();
          };
        }), 'original-version-enhancements: workspace opener actions');
      },
    };
  },
});
