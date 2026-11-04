window.__ModuleLoader__.load({
  id: '@local/dsh-work-steps-quick-switch',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'work-steps-quick-switch';
    /** The four accepted work-details modes, in the same order as Settings. */
    const MODES = ['compact', 'standard', 'detailed', 'verbose'];
    /** Saved values from older generations of the same Host setting. */
    const LEGACY_MODES = { normal: 'detailed', expanded: 'detailed' };
    /** Match ui-chat's default: Desktop starts at Standard, other Web clients at Detailed. */
    const DEFAULT_MODE = 'dshDesktop' in globalThis ? 'standard' : 'detailed';

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
      .tqs-root[data-error="true"] {
        border-color: var(--dsw-alias-state-error-primary);
      }
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
      .tqs-button:hover {
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-layer-2);
      }
      .tqs-button:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary);
        outline-offset: -2px;
      }
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
     * @returns the segmented control.
     */
    function WorkStepsQuickSwitch({ form, t }) {
      const tr = typeof t === 'function' ? t : (key) => key;
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

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'work-steps-quick-switch: dictionaries');

        ctx.effect(() => ctx.configForms.whileServed(['ui-chat'], () => {
          const form = ctx.configForms.get('ui-chat');
          const register = (slot, order) => ctx.slots.inject(slot, () => ctx.slots.register({
            name: slot,
            id: 'work-steps-quick-switch',
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
        }), 'work-steps-quick-switch: workspace opener actions');
      },
    };
  },
});
