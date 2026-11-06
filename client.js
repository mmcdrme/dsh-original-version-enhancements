window.__ModuleLoader__.load({
  id: '@local/dsh-original-version-enhancements',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'original-version-enhancements';
    /** Route prefix registered by the Host half. */
    const ROUTE_ROOT = '/plugins/original-version-enhancements';
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
      pageIntro: '把官方界面缺少的快捷操作集中在这里，并按需开关。开关保存在当前浏览器。',
      featuresTitle: '功能开关',
      'switch.steps': '工作步骤展示快捷切换',
      'switch.steps.desc': '在会话标题栏与右侧文件面板的「用资源管理器打开」左侧显示四个档位图标。',
      'switch.chat': '聊天记录管理',
      'switch.chat.desc': '在下方管理已归档会话：搜索聊天内容、取消归档或永久删除。',
      chatTitle: '已归档会话',
      chatIntro: '搜索已归档会话的名称、工作区或聊天内容；永久删除只针对已归档且未被宿主加载的本机会话，无法恢复。',
      searchPlaceholder: '搜索名称、工作区或聊天内容',
      searchLabel: '搜索已归档会话',
      searching: '正在搜索归档内容…',
      noRows: '暂无匹配的归档会话',
      noArchives: '当前没有已归档的会话',
      ungrouped: '未分组',
      restore: '取消归档',
      delete: '永久删除',
      cancel: '取消',
      confirmDelete: '确认永久删除',
      deleting: '正在删除…',
      restoring: '正在取消归档…',
      deleteTitle: '永久删除会话？',
      deleteDesc: '只删除已归档且未加载的本机会话记录，无法恢复。',
      searchMore: '仅显示前 20 条内容匹配，请缩小搜索范围。',
      loadFailed: '聊天记录管理不可用：',
      footnote: '原版功能增强 · 聊天记录管理部分改编自 dsh-chat-manager（MIT）。',
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
      'switch.chat.desc': 'Manage archived sessions below: search messages, unarchive, or delete permanently.',
      chatTitle: 'Archived sessions',
      chatIntro: 'Search archived session names, workspaces, or chat content. Permanent deletion only applies to unloaded archived local sessions and cannot be undone.',
      searchPlaceholder: 'Search names, workspaces or messages',
      searchLabel: 'Search archived sessions',
      searching: 'Searching archived messages…',
      noRows: 'No matching archived sessions',
      noArchives: 'No archived sessions',
      ungrouped: 'Ungrouped',
      restore: 'Unarchive',
      delete: 'Delete permanently',
      cancel: 'Cancel',
      confirmDelete: 'Confirm permanent deletion',
      deleting: 'Deleting…',
      restoring: 'Unarchiving…',
      deleteTitle: 'Permanently delete session?',
      deleteDesc: 'Only an unloaded, archived local session can be deleted. This cannot be undone.',
      searchMore: 'Showing the first 20 content matches. Narrow your search.',
      loadFailed: 'Chat history manager unavailable: ',
      footnote: 'Original Version Enhancements · the chat history part is adapted from dsh-chat-manager (MIT).',
    };

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
      .ove-confirm { display: grid; gap: 8px; width: 100%; padding: 10px 0 0; }
      .ove-confirm-text { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
      .ove-footnote { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
    `;

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

    /**
     * Feature switches plus the archived-session manager.
     * @param props - standard settings-section props plus the plugin translator.
     * @returns the plugin page.
     */
    function PluginPage({ useSessions, useWorkspaces, t, ctx }) {
      const tr = typeof t === 'function' ? t : (key) => key;
      const flags = useFlags();
      const sessions = typeof useSessions === 'function' ? useSessions((s) => s) : undefined;
      const workspaces = typeof useWorkspaces === 'function' ? useWorkspaces((s) => s) : undefined;

      const [query, setQuery] = React.useState('');
      const [matches, setMatches] = React.useState(new Map());
      const [hasMore, setHasMore] = React.useState(false);
      const [searching, setSearching] = React.useState(false);
      const [searchError, setSearchError] = React.useState('');
      const [busy, setBusy] = React.useState(null);
      const [pendingDelete, setPendingDelete] = React.useState(null);
      const [actionError, setActionError] = React.useState('');
      const [notice, setNotice] = React.useState('');

      const normalized = query.trim();
      const showChat = flags.chatManager;

      React.useEffect(() => {
        if (!showChat || normalized.length === 0) {
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
            const body = await response.json();
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
      }, [showChat, normalized]);

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

      const refreshStores = async () => {
        const tasks = [];
        for (const name of ['sessions', 'workspaces']) {
          const store = ctx.get(name);
          if (typeof store?.refresh === 'function') {
            tasks.push(Promise.resolve(store.refresh()).catch(() => undefined));
          }
        }
        await Promise.all(tasks);
      };

      const restore = async (row) => {
        if (busy !== null) return;
        setBusy(row.id);
        setActionError('');
        setNotice('');
        try {
          const service = ctx.get('workspaces');
          if (typeof service?.unarchiveSession !== 'function') {
            throw new Error(tr('loadFailed') + 'workspaces.unarchiveSession');
          }
          await service.unarchiveSession(row.id);
          setNotice(`${tr('restore')} · ${row.title}`);
          await refreshStores();
        } catch (error) {
          setActionError(String(error?.message ?? error));
        } finally {
          setBusy(null);
        }
      };

      const remove = async (row) => {
        if (busy !== null) return;
        setBusy(row.id);
        setActionError('');
        setNotice('');
        try {
          const response = await fetch(`${ROUTE_ROOT}/sessions/delete`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-dsh-session-delete-confirmation': 'delete-session',
            },
            body: JSON.stringify({ sessionId: row.id }),
          });
          const body = await response.json();
          if (!response.ok || body?.ok !== true) {
            throw Error(body?.error?.message || `HTTP ${response.status}`);
          }
          setPendingDelete(null);
          setNotice(`${tr('delete')} · ${row.title}`);
          await refreshStores();
        } catch (error) {
          setActionError(String(error?.message ?? error));
        } finally {
          setBusy(null);
        }
      };

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

          showChat && h('div', { className: 'ove-chat' },
            h('div', { className: 'ove-head' },
              h('h2', { className: 'ove-group-title' }, tr('chatTitle')),
              h('p', { className: 'ove-intro' }, tr('chatIntro'))),
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
                  pendingDelete !== row.id && h('button', {
                    type: 'button',
                    className: 'ove-btn ove-btn-danger',
                    disabled: busy !== null,
                    onClick: () => { setPendingDelete(row.id); setActionError(''); setNotice(''); },
                  }, tr('delete'))),
                pendingDelete === row.id && h('div', { className: 'ove-confirm' },
                  h('div', { className: 'ove-confirm-text' }, `${tr('deleteTitle')} ${row.title} — ${tr('deleteDesc')}`),
                  h('div', { className: 'ove-actions' },
                    h('button', {
                      type: 'button',
                      className: 'ove-btn',
                      disabled: busy !== null,
                      onClick: () => setPendingDelete(null),
                    }, tr('cancel')),
                    h('button', {
                      type: 'button',
                      className: 'ove-btn ove-btn-danger',
                      disabled: busy !== null,
                      onClick: () => remove(row),
                    }, busy === row.id ? tr('deleting') : tr('confirmDelete'))))

              )))
          ),

          h('p', { className: 'ove-footnote' }, tr('footnote'))),
      );
    }

    return {
      inject: ['slots', 'locale', 'configForms', 'workspaces', 'sessions'],
      apply(ctx) {
        const text = (key) => ctx.locale.getSnapshot().active === 'zh' ? (zh[key] ?? key) : (en[key] ?? key);

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'original-version-enhancements: dictionaries');

        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'original-version-enhancements',
          order: 22,
          label: () => text('pageTitle'),
          inject: () => ({ t: (key) => text(key), ctx }),
        }, PluginPage)), 'original-version-enhancements: plugin page');

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
