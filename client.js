window.__ModuleLoader__.load({
  id: '@local/dsh-original-version-enhancements',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
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
    const RESTORE_ROUTE = `${ROUTE_ROOT}/sessions/restore`;
    const PURGE_ROUTE = `${ROUTE_ROOT}/sessions/purge`;
    const TRANSFER_ROUTE = `${ROUTE_ROOT}/sessions/transfer`;
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
    const DEFAULT_FLAGS = { stepSwitcher: true, chatManager: true, automation: true };
    const flagListeners = new Set();

    const readFlags = () => {
      try {
        const raw = JSON.parse(globalThis.localStorage?.getItem(FLAGS_KEY) ?? '{}');
        const flags = raw !== null && typeof raw === 'object' ? raw : {};
        return {
          stepSwitcher: flags.stepSwitcher !== false,
          chatManager: flags.chatManager !== false,
          automation: flags.automation !== false,
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

    /* ------------------------------------------------------------------ */
    /* Undo receipt of a permanent deletion                                */
    /* ------------------------------------------------------------------ */

    /**
     * The floating receipts a finished deletion leaves behind. Each one carries
     * the token the Host kept the (already removed) session under, so the same
     * toast can put it back until its window closes. They are kept in a small
     * queue: deleting twice in a row must not silently drop the first undo.
     */
    const MAX_DELETE_NOTICES = 3;
    let deleteNotices = [];
    let deleteNoticeSeq = 0;
    const deleteNoticeListeners = new Set();

    const emitDeleteNotices = () => {
      for (const listener of deleteNoticeListeners) listener();
    };

    /** Drop one receipt's retained copy, if it still owns one. */
    const abandonDeleteNotice = (notice) => {
      if (typeof notice?.token === 'string' && notice.token.length > 0) void requestPurge(notice.token);
    };

    const pushDeleteNotice = (notice) => {
      deleteNoticeSeq += 1;
      const next = [...deleteNotices, { ...notice, seq: deleteNoticeSeq }];
      // The oldest receipt has been on screen the longest; its retained copy is
      // dropped rather than left for the Host's hourly sweep.
      while (next.length > MAX_DELETE_NOTICES) {
        abandonDeleteNotice(next.shift());
      }
      deleteNotices = next;
      emitDeleteNotices();
      return deleteNoticeSeq;
    };

    const dismissDeleteNotice = (seq) => {
      const next = deleteNotices.filter((notice) => notice.seq !== seq);
      if (next.length === deleteNotices.length) return;
      deleteNotices = next;
      emitDeleteNotices();
    };

    const clearDeleteNotices = () => {
      if (deleteNotices.length === 0) return;
      deleteNotices = [];
      emitDeleteNotices();
    };

    const subscribeDeleteNotice = (listener) => {
      deleteNoticeListeners.add(listener);
      return () => { deleteNoticeListeners.delete(listener); };
    };

    const getDeleteNotices = () => deleteNotices;


    /* ------------------------------------------------------------------ */
    /* Pending session transfer, shared by the two menu rows and its panel */
    /* ------------------------------------------------------------------ */

    /**
     * `target` is the session being moved or copied, `mode` decides whether the
     * original is removed afterwards, `picks` the subset chosen for a
     * multi-workspace copy, and `notice` is the transient receipt that carries
     * its own undo. The candidate workspaces are NOT copied in here: they are
     * derived live from the Client Workspace state when the panel renders, so a
     * menu opened before that state finished loading still ends up with the
     * real list instead of an empty one.
     */
    let transferState = {
      target: null,
      mode: 'copy',
      picks: [],
      busy: false,
      error: '',
      done: '',
      notice: null,
    };
    let transferNoticeSeq = 0;
    const transferListeners = new Set();

    const publishTransfer = (patch) => {
      transferState = { ...transferState, ...patch };
      for (const listener of transferListeners) listener();
    };

    const subscribeTransfer = (listener) => {
      transferListeners.add(listener);
      return () => { transferListeners.delete(listener); };
    };

    const getTransfer = () => transferState;

    /**
     * Split one Workspace snapshot into "where the session is" and "where it may
     * go". Derived on every relevant render rather than captured when the menu
     * opens: both the archive membership (menu rows) and the target list (panel)
     * must follow the stream, including its first baseline.
     * @param snapshot - the Client Workspace snapshot, when available.
     * @param target - the pending session (`null` while no panel is open).
     * @param tr - translator for the ungrouped label.
     * @returns the origin label, source workspace id, target list, and readiness.
     */
    const transferChoices = (snapshot, target, tr) => {
      const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
      // The snapshot spells the identity differently across versions; the path is
      // always present and the Host resolves either spelling.
      const idOf = (item) => String(item?.workspaceId ?? item?.id ?? item?.path ?? '');
      const sessionId = target?.id;
      const owner = items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId));
      const ownerId = idOf(owner);
      const targets = items
        .filter((item) => idOf(item) !== ownerId)
        .map((item) => ({
          id: idOf(item),
          title: String(item.title || item.path || item.directory || idOf(item)),
          path: typeof item.path === 'string' ? item.path : '',
        }))
        .filter((item) => item.id.length > 0);
      return {
        ready: snapshot?.phase === 'ready',
        origin: owner === undefined ? tr('ungrouped') : String(owner.title || owner.path || ''),
        sourceWorkspaceId: ownerId,
        // The recorded directory is enough for the Host to resolve the source
        // even when the conversation is not filed under any workspace.
        sourceCwd: typeof owner?.path === 'string' ? owner.path : '',
        targets,
      };
    };

    /** Open the workspace chooser for one session. */
    const openTransfer = (target, mode) => {
      publishTransfer({ target, mode, picks: [], busy: false, error: '', done: '' });
    };

    /**
     * Mount an overlay on `document.body`. The settings panel and the app frame
     * both clip positioned overlays, and the session menu can open this dialog
     * on a page where no other plugin surface (and therefore no stylesheet) is
     * mounted, so the overlay carries its own styles and escapes both.
     * @param node - the React node to mount.
     * @returns the portal, or the node itself when portals are unavailable.
     */
    const overlayPortal = (node) => (
      typeof document !== 'undefined' && typeof ReactDOM?.createPortal === 'function'
        ? ReactDOM.createPortal(node, document.body)
        : node
    );

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
     * Leave the main panel when the Session it shows has just been removed.
     * The shipped archive action does exactly this (`clearMain()`: drop the
     * selection, release the retained Session, deselect the panel), so a deleted
     * Session behaves like an archived one instead of leaving its now-missing
     * conversation on screen. `mainReference` is what that action itself reads;
     * the persisted `selection` store is the fallback witness.
     * @param ctx - the Client plugin context (carries `uiWorkspace`).
     * @param sessionId - the Session that was just removed.
     */
    const leaveRemovedSession = (ctx, sessionId) => {
      try {
        const uiWorkspace = ctx?.uiWorkspace;
        if (uiWorkspace === undefined) return;
        const current = uiWorkspace.mainReference?.sessionId ?? uiWorkspace.selection?.getSnapshot?.()?.sessionId;
        if (current !== sessionId) return;
        if (typeof uiWorkspace.clearMain === 'function') {
          uiWorkspace.clearMain();
        } else if (typeof uiWorkspace.clearArchivedCurrent === 'function') {
          // The removed id is already out of the archive set by the Host, so
          // this only helps in the narrow race where it is still listed.
          uiWorkspace.clearArchivedCurrent();
        }
      } catch { /* leaving the page is best-effort: the deletion already succeeded */ }
    };

    /**
     * Wording for a transport failure. The Host's own failures already carry a
     * Chinese message; this only covers the cases where the browser would
     * otherwise print "Failed to fetch" or "HTTP 500" into the panel.
     * @param error - the value a fetch/parse path threw.
     * @returns a sentence a person can act on.
     */
    const describeRequestFailure = (error) => {
      if (typeof error?.hostStatus === 'number') {
        console.warn('original-version-enhancements: the Host answered with a non-JSON body', error);
        return `宿主返回了无法解析的响应（HTTP ${error.hostStatus}），请查看宿主日志。`;
      }
      if (error instanceof TypeError) {
        console.warn('original-version-enhancements: cannot reach the Host', error);
        return '无法连接宿主，请确认 DeepSeek Harness 仍在运行。';
      }
      const message = String(error?.message ?? error);
      return message.length > 0 ? message : '请求失败，请稍后重试。';
    };

    /** Wording for a response that failed without describing why. */
    const describeHttpStatus = (status) => `宿主返回了 HTTP ${status}，请查看宿主日志。`;

    /**
     * Read a JSON body, turning an empty or non-JSON answer into a status error.
     * @param response - the fetch response.
     * @returns the parsed JSON payload.
     */
    const readJson = async (response) => {
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch (error) {
        const failure = new Error(`host answered with non-JSON HTTP ${response.status}`);
        failure.hostStatus = response.status;
        failure.cause = error;
        throw failure;
      }
    };

    /**
     * Ask the Host to remove one session; shared by the page and menu dialogs.
     * @param ctx - the client plugin context.
     * @param target - the session id and display title.
     * @param force - bypass the persistence lease for a pre-loaded session.
     * @param retain - keep the removed storage in the Host's undo trash. On for a
     *   human deletion (its receipt offers undo), off for the transfer undo,
     *   whose copies are only ever discarded.
     * @returns the outcome, the Host failure code, and the undo token.
     */
    const requestDelete = async (ctx, target, force, retain = true) => {
      try {
        const response = await fetch(DELETE_ROUTE, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-dsh-session-delete-confirmation': 'delete-session',
            ...(force ? { 'x-dsh-session-delete-force': 'force' } : {}),
          },
          // `retain` keeps the removed storage in the Host's undo trash, which is
          // what the receipt's "撤销" hands back. A deletion without it would be
          // final the moment the request returns.
          body: JSON.stringify({ sessionId: target.id, ...(retain ? { retain: true } : {}) }),
        });
        const body = await readJson(response);
        if (!response.ok || body?.ok !== true) {
          const failure = body?.error ?? {};
          return {
            ok: false,
            error: failure.message || describeHttpStatus(response.status),
            code: typeof failure.code === 'string' ? failure.code : '',
          };
        }
        await refreshStores(ctx);
        leaveRemovedSession(ctx, target.id);
        const token = body.value?.retained?.token;
        return { ok: true, token: typeof token === 'string' ? token : '' };
      } catch (error) {
        return { ok: false, error: describeRequestFailure(error), code: '' };
      }
    };

    /**
     * Ask the Host to put one retained deletion back.
     * @param ctx - the client plugin context.
     * @param token - the receipt's undo token.
     * @returns the outcome, or the Host failure.
     */
    const requestRestore = async (ctx, token) => {
      try {
        const response = await fetch(RESTORE_ROUTE, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-dsh-session-delete-confirmation': 'delete-session',
          },
          body: JSON.stringify({ token }),
        });
        const body = await readJson(response);
        if (!response.ok || body?.ok !== true) {
          const failure = body?.error ?? {};
          return { ok: false, error: failure.message || describeHttpStatus(response.status) };
        }
        await refreshStores(ctx);
        return { ok: true, value: body.value ?? {} };
      } catch (error) {
        return { ok: false, error: describeRequestFailure(error) };
      }
    };

    /**
     * Drop one retained deletion for good. Best effort: the Host sweeps stale
     * entries on its next start anyway, so a failure here is not an error.
     * @param token - the receipt's undo token.
     * @returns nothing.
     */
    const requestPurge = async (token) => {
      if (typeof token !== 'string' || token.length === 0) return;
      try {
        await fetch(PURGE_ROUTE, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-dsh-session-delete-confirmation': 'delete-session',
          },
          body: JSON.stringify({ token }),
          keepalive: true,
        });
      } catch { /* the sweep on the next start removes it */ }
    };

    /**
     * Ask the Host to copy — or copy and then remove — one session into another
     * workspace.
     * @param ctx - the client plugin context.
     * @param request - source session, target workspace, and the mode.
     * @returns the outcome with the new session id, or the Host failure.
     */
    const requestTransfer = async (ctx, request) => {
      try {
        const response = await fetch(TRANSFER_ROUTE, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-dsh-session-transfer-confirmation': 'transfer-session',
          },
          body: JSON.stringify({
            sessionId: request.sessionId,
            workspaceId: request.workspaceId,
            mode: request.mode,
          }),
        });
        const body = await readJson(response);
        if (!response.ok || body?.ok !== true) {
          const failure = body?.error ?? {};
          return {
            ok: false,
            error: failure.message || describeHttpStatus(response.status),
            code: typeof failure.code === 'string' ? failure.code : '',
            copyId: typeof failure.copyId === 'string' ? failure.copyId : '',
          };
        }
        await refreshStores(ctx);
        return { ok: true, value: body.value ?? {} };
      } catch (error) {
        return { ok: false, error: describeRequestFailure(error), code: '' };
      }
    };

    /**
     * Undo one transfer: drop the copies a copy created, or put a moved session
     * back where it came from (a reverse move recreates it and removes the copy).
     * @param ctx - the client plugin context.
     * @param undo - the receipt's undo payload.
     * @returns whether the workspace grouping is back to its previous shape.
     */
    const undoTransfer = async (ctx, undo) => {
      if (undo?.kind === 'move') {
        const created = Array.isArray(undo.created) ? undo.created : [];
        const first = created[0];
        const workspaceId = typeof undo.sourceWorkspaceId === 'string' ? undo.sourceWorkspaceId : '';
        const sourceCwd = typeof undo.sourceCwd === 'string' ? undo.sourceCwd : '';
        // The Host resolves either an id or the recorded directory.
        const destination = workspaceId.length > 0 ? workspaceId : sourceCwd;
        if (first === undefined || destination.length === 0) return { ok: false, unavailable: true };
        const result = await requestTransfer(ctx, {
          sessionId: first.sessionId,
          workspaceId: destination,
          mode: 'move',
        });
        return result.ok
          ? { ok: true }
          : {
              ok: false,
              error: result.code === 'workspace-not-found' ? undefined : result.error,
              unavailable: result.code === 'workspace-not-found',
            };
      }
      const created = Array.isArray(undo?.created) ? undo.created : [];
      let ok = true
      for (const item of created) {
        const plain = await requestDelete(ctx, { id: item.sessionId, title: item.title }, false, false)
        if (plain.ok) continue
        // A still-loaded session refuses the ordinary path; the receipt already
        // promised the undo, so fall back to the forced removal.
        const forced = await requestDelete(ctx, { id: item.sessionId, title: item.title }, true, false)
        if (!forced.ok) ok = false
      }
      await refreshStores(ctx)
      return { ok }
    };

    /* ------------------------------------------------------------------ */
    /* Dictionaries                                                        */
    /* ------------------------------------------------------------------ */

    /**
     * Every user-visible string lives in `locale/lang.json`, which the Host
     * serves from disk on every request (no cache): wording is edited as plain
     * data, without touching this file or rebuilding anything, and a page
     * refresh shows the edit.
     */
    const LANG_ROUTE = `${ROUTE_ROOT}/lang`;
    /** Live catalogues; replaced in place once the Host answers. */
    const catalogue = { zh: {}, en: {} };

    /**
     * Take the catalogues the Host returned. A response with the wrong shape is
     * ignored rather than wiping the fallback, so a broken language file
     * degrades to key names instead of an empty interface.
     */
    const adoptCatalogue = (loaded) => {
      if (loaded !== null && typeof loaded === 'object') {
        if (loaded.zh !== null && typeof loaded.zh === 'object') catalogue.zh = loaded.zh;
        if (loaded.en !== null && typeof loaded.en === 'object') catalogue.en = loaded.en;
      }
      return catalogue;
    };

    /** Fetch both catalogues; the Host answers `{ ok:false, error }` for a bad file. */
    const loadCatalogue = async () => {
      const response = await fetch(LANG_ROUTE, { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    };

    /* ------------------------------------------------------------------ */
    /* Styles                                                              */
    /* ------------------------------------------------------------------ */

    /**
     * The stylesheet lives in `css/style.css` and is served by the Host from
     * disk on every request (no cache), like the language catalogue, so a rule
     * can be edited on its own and shows up on the next page refresh. It stays a
     * string rather than a <link> because every surface of this plugin renders
     * its own <style> element: a surface must be styled even on a page where no
     * other part of the plugin is mounted.
     *
     * The route deliberately has no `.css` suffix. Download managers (IDM and
     * friends) hook every sub-resource a page loads and capture a URL whose path
     * ends in a file type on their list, popping a download dialog on each
     * reload; the extension is not part of the protocol, so dropping it keeps
     * the stylesheet off that list while the response still says `text/css`.
     */
    const STYLE_ROUTE = `${ROUTE_ROOT}/style`;
    /** Injected stylesheet text; filled before anything registers. */
    let CSS = '';

    /** Fetch the stylesheet; the Host answers 500 when the file is unreadable. */
    const loadStyle = async () => {
      const response = await fetch(STYLE_ROUTE, { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      CSS = await response.text();
      return CSS;
    };

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
      const settleTimer = React.useRef(0);

      React.useEffect(() => () => clearTimeout(settleTimer.current), []);

      React.useEffect(() => {
        if (form === undefined || typeof form.subscribe !== 'function') return undefined;
        const sync = () => setLive(readMode());
        sync();
        return form.subscribe(sync);
      }, [form]);

      React.useEffect(() => {
        if (pending !== null && live === pending) {
          clearTimeout(settleTimer.current);
          setPending(null);
        }
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
        clearTimeout(settleTimer.current);
        // An accepted write is not proof the form moved: the Host may normalise
        // the value, another surface may overwrite it, or the form may only
        // publish on its next snapshot. Without this the busy state lived on
        // forever (and the clicked mode stayed pressed).
        settleTimer.current = setTimeout(() => {
          if (request.current !== current) return;
          if (readMode() === mode) return;
          setPending(null);
          setFailed(true);
        }, 2000);
        let result;
        try {
          result = form.set('transcriptView', mode);
        } catch (_error) {
          clearTimeout(settleTimer.current);
          setPending(null);
          setFailed(true);
          return;
        }
        Promise.resolve(result).then((accepted) => {
          if (request.current !== current) return;
          if (accepted === false) {
            clearTimeout(settleTimer.current);
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
                }, h('span', { className: 'ove-switch-thumb' }))),

              h('div', { className: 'ove-row' },
                h('div', { className: 'ove-row-text' },
                  h('div', { className: 'ove-row-title' }, tr('switch.automation')),
                  h('div', { className: 'ove-row-desc' }, tr('switch.automation.desc'))),
                h('button', {
                  type: 'button',
                  className: 'ove-switch',
                  role: 'switch',
                  'aria-checked': flags.automation,
                  'aria-label': tr('switch.automation'),
                  onClick: () => toggle('automation'),
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
      const deleteBusyRef = React.useRef(false);

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
              throw Error(body?.error?.message || describeHttpStatus(response.status));
            }
            if (controller.signal.aborted) return;
            const next = new Map();
            for (const item of body.value?.items ?? []) next.set(item.sessionId, item.snippet);
            setMatches(next);
            setHasMore(body.value?.hasMore === true);
          } catch (error) {
            if (!controller.signal.aborted) setSearchError(describeRequestFailure(error));
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
        if (deleteBusyRef.current) return;
        setPending(null);
        setDeleteError('');
        setDeleteCode('');
      };

      const confirmDelete = async (force) => {
        // `deleteBusy` only reflects the previous render; the ref makes a
        // double click idempotent so the second outcome cannot overwrite the
        // first one after the dialog has closed.
        if (pending === null || deleteBusyRef.current) return;
        deleteBusyRef.current = true;
        setDeleteBusy(true);
        setDeleteError('');
        setDeleteCode('');
        const result = await requestDelete(ctx, pending, force);
        deleteBusyRef.current = false;
        setDeleteBusy(false);
        if (result.ok) {
          setNotice(`${tr('delete')} · ${pending.title}`);
          setPending(null);
          setDeleteCode('');
          // The receipt carries the undo; a Host that did not retain the storage
          // (an older composition) leaves the token empty and the toast is a
          // plain confirmation.
          pushDeleteNotice({
            text: `${tr('delete')} · ${pending.title}`,
            tone: 'success',
            token: result.token ?? '',
            seconds: 10,
          });
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
    /* Session context menu: move or copy into another workspace           */
    /* ------------------------------------------------------------------ */

    /** Action tone: blue for move, green for copy (matches the row colours). */
    const transferTone = (mode) => (mode === 'move' ? '#2563eb' : '#16a34a');

    /**
     * Folder-and-arrow glyph for "move", two stacked cards for "copy".
     * @param props - which of the two actions the row performs, and its colour.
     * @returns the inline icon.
     */
    function TransferIcon({ mode, tone }) {
      const common = {
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
        style: { display: 'block', pointerEvents: 'none', ...(tone === undefined ? {} : { color: tone }) },
      };
      if (mode === 'move') {
        return h('svg', common,
          h('path', { d: 'M1.8 4.7h3.3l1 1.2h4.1v5.5H1.8z' }),
          h('path', { d: 'M10.9 8.4h3.3M12.9 6.7l1.7 1.7-1.7 1.7' }));
      }
      return h('svg', common,
        h('path', { d: 'M5.9 5.4V3.9A1.4 1.4 0 0 1 7.3 2.5h4.4A1.4 1.4 0 0 1 13.1 3.9v4.4a1.4 1.4 0 0 1-1.4 1.4h-1.5' }),
        h('rect', { x: 2.6, y: 5.9, width: 7.6, height: 7.6, rx: 1.5 }));
    }

    /**
     * Self-contained styles for the fallback rows. The session menu can open on a
     * page where no other surface of this plugin is mounted, so the page CSS that
     * normally styles `.ove-menu-item` may be absent; a bare `<button>` would then
     * render as a bordered, centred browser button instead of a menu row.
     * @returns the style element.
     */
    const transferMenuStyles = () => h('style', {
      key: 'styles',
      'data-plugin-css': `${NS}-menu-transfer`,
    }, `
      .ove-menu-item {
        display: flex; align-items: center; gap: 7px; width: 100%; box-sizing: border-box;
        padding: 6px 8px; border: 0; border-radius: 6px; background: transparent;
        font-size: 13px; line-height: 20px; text-align: left; cursor: pointer;
        -webkit-tap-highlight-color: transparent; transition: background .12s ease;
      }
      .ove-menu-item:hover, .ove-menu-item:focus-visible {
        background: var(--dsw-alias-bg-layer-2); outline: none;
      }
      .ove-menu-icon { flex: none; display: block; }
      .ove-menu-item.ove-menu-move { color: #2563eb; }
      .ove-menu-item.ove-menu-copy { color: #16a34a; }
      .ove-menu-item.ove-menu-move:hover, .ove-menu-item.ove-menu-move:focus-visible {
        background: rgba(37, 99, 235, .12);
      }
      .ove-menu-item.ove-menu-copy:hover, .ove-menu-item.ove-menu-copy:focus-visible {
        background: rgba(22, 163, 74, .12);
      }
    `);

    /**
     * The Client Workspace state model behind `ctx.workspaces`. Its snapshot
     * carries the durable archive set and its subscription fires whenever the
     * Host pushes a new one (the same face `uiWorkspace.archiveSession` writes).
     * @param ctx - the Client plugin context.
     * @returns the model, or undefined when this composition exposes none.
     */
    const workspaceModelOf = (ctx) => {
      const service = ctx?.workspaces;
      const model = service?.list ?? service?.model;
      return typeof model?.getSnapshot === 'function' ? model : undefined;
    };

    /** Stable fallback snapshot: `useSyncExternalStore` requires one identity. */
    const EMPTY_WORKSPACE_SNAPSHOT = {
      items: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      state: 'loading',
      phase: 'pending',
      error: null,
    };

    /**
     * Subscribe to the Client Workspace state and read its cached snapshot. The
     * session menu does not hand entries a `useWorkspaces` hook, so the menu
     * rows and the chooser share this live read instead: the archive set and the
     * target list stay correct even when the menu opens before the stream's
     * first baseline, and follow every later push.
     * @param ctx - the Client plugin context.
     * @returns the current Workspace snapshot (never undefined).
     */
    function useWorkspaceSnapshot(ctx) {
      const model = workspaceModelOf(ctx);
      const subscribe = React.useCallback((notify) => {
        if (typeof model?.subscribe !== 'function') return () => {};
        const off = model.subscribe(notify);
        return () => {
          try { off(); } catch { /* the model was already disposed */ }
        };
      }, [model]);
      const read = React.useCallback(() => {
        try {
          return model?.getSnapshot?.() ?? EMPTY_WORKSPACE_SNAPSHOT;
        } catch {
          return EMPTY_WORKSPACE_SNAPSHOT;
        }
      }, [model]);
      return React.useSyncExternalStore(subscribe, read, read);
    }

    /**
     * Whether one Session is archived. The Session menu target only carries the
     * id and title, so this reads the Workspace archive set itself and keeps the
     * answer live; archived rows are not offered move/copy because the stock
     * menu only gives them Unarchive (and an archived conversation should be
     * restored, not silently re-filed into another workspace).
     * Until the archive set has arrived, the answer is "archived" for safety:
     * offering the rows and then having them vanish is exactly the flicker this
     * guard exists to prevent, and a menu opened during that window is normally
     * closed again long before the baseline lands.
     * @param ctx - the Client plugin context.
     * @param sessionId - the Session whose archive membership is wanted.
     * @returns true while that id is in the archive set, or before it is known.
     */
    function useArchivedSession(ctx, sessionId) {
      const model = workspaceModelOf(ctx);
      const snapshot = useWorkspaceSnapshot(ctx);
      if (model === undefined) return false;
      if (snapshot?.phase !== 'ready') return true;
      const ids = snapshot?.archivedSessionIds;
      return Array.isArray(ids) && ids.includes(sessionId);
    }

    /**
     * Right-click row action: move or copy one session into another workspace.
     * @param props - owner props, menu hook, translator, plugin context, mode.
     * @returns the menu row.
     */
    function SessionTransferMenuItem({ sessionId, displayTitle, useMenuOpenState, t, ctx, mode }) {
      const tr = typeof t === 'function' ? t : (key) => key;
      const [, closeMenu] = useMenuOpenState();
      const archived = useArchivedSession(ctx, sessionId);
      const label = tr(mode === 'move' ? 'menuMove' : 'menuCopy');

      // An archived Session has no workspace row on the stock sidebar; the menu
      // it opens is the archive-only one, where filing it elsewhere makes no
      // sense. Hiding the row keeps that menu identical to the stock one.
      if (archived) return null;

      const select = () => {
        closeMenu(false);
        openTransfer({ id: sessionId, title: displayTitle || sessionId }, mode);
      };

      const tone = transferTone(mode);

      // Render the shipped menu row whenever the primitives are available: it
      // carries its own layout, hover and keyboard behaviour, so the row looks
      // native on every page (a bare <button> only looked right while some other
      // surface of this plugin happened to have its stylesheet mounted).
      if (uiPrimitives?.MenuItemButton) {
        return h(uiPrimitives.MenuItemButton, {
          icon: h(TransferIcon, { mode, tone }),
          onSelect: select,
        }, h('span', { style: { color: tone } }, label));
      }

      return h(React.Fragment, null,
        transferMenuStyles(),
        h('button', {
          type: 'button',
          role: 'menuitem',
          className: `ove-menu-item ove-menu-${mode === 'move' ? 'move' : 'copy'}`,
          style: { color: tone },
          onClick: select,
        }, h(TransferIcon, { mode }), h('span', null, label)));
    }

    /**
     * Target-workspace chooser for a pending move or copy. A move applies to the
     * clicked workspace at once; a copy collects several workspaces and applies
     * them together.
     * @param props - injected translator and the plugin context.
     * @returns the overlay, or nothing while no session is pending.
     */
    function SessionTransferDialog({ t, ctx }) {
      const tr = typeof t === 'function' ? t : (key) => key;
      const state = React.useSyncExternalStore(subscribeTransfer, getTransfer, getTransfer);
      const workspaceSnapshot = useWorkspaceSnapshot(ctx);
      const [busy, setBusy] = React.useState(false);

      React.useEffect(() => {
        if (state.target === null) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape' && !transferState.busy) {
            publishTransfer({ target: null, picks: [], busy: false, error: '', done: '' });
          }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [state.target]);

      if (state.target === null) return null;

      // Derived from the live Workspace snapshot, not captured when the menu
      // opened: a menu opened before the stream's first baseline now fills in
      // its target list as soon as that baseline lands.
      const choices = transferChoices(workspaceSnapshot, state.target, tr);
      const move = state.mode === 'move';
      const picked = move ? [] : state.picks;
      const close = () => {
        if (transferState.busy) return;
        publishTransfer({ target: null, picks: [], busy: false, error: '', done: '' });
      };

      /** Close the chooser and publish the receipt that carries the undo. */
      const finish = (notice) => {
        transferNoticeSeq += 1;
        publishTransfer({
          target: null,
          picks: [],
          busy: false,
          error: '',
          done: '',
          notice: { ...notice, seq: transferNoticeSeq },
        });
      };

      const runOne = async (workspace) => {
        if (transferState.busy) return
        publishTransfer({ busy: true, error: '', done: '' });
        setBusy(true);
        const sourceId = choices.sourceWorkspaceId;
        const result = await requestTransfer(ctx, {
          sessionId: transferState.target.id,
          workspaceId: workspace.id,
          mode: transferState.mode,
        });
        setBusy(false);
        if (!result.ok) {
          publishTransfer({ busy: false, error: `${tr('transferFailed')}${result.error}` });
          return;
        }
        finish({
          text: `${tr('transferDoneMove')} ${workspace.title}`,
          tone: 'success',
          undo: (() => {
            // Prefer the source the Host reported: it also covers a conversation
            // that is not filed under any workspace (its directory is enough).
            const source = result.value?.source ?? {};
            const sourceWorkspaceId = typeof source.workspaceId === 'string' && source.workspaceId.length > 0
              ? source.workspaceId
              : sourceId;
            const sourceCwd = typeof source.cwd === 'string' && source.cwd.length > 0
              ? source.cwd
              : choices.sourceCwd;
            if (sourceWorkspaceId.length === 0 && sourceCwd.length === 0) return null;
            return {
              kind: 'move',
              created: [{ sessionId: String(result.value?.sessionId ?? ''), workspaceId: workspace.id, title: workspace.title }],
              sourceWorkspaceId,
              sourceCwd,
            };
          })(),
        });
      };

      const runMany = async () => {
        if (transferState.busy) return
        const chosen = choices.targets.filter((workspace) => state.picks.includes(workspace.id));
        if (chosen.length === 0) {
          publishTransfer({ error: tr('transferNoPick') });
          return;
        }
        publishTransfer({ busy: true, error: '', done: '' });
        setBusy(true);
        const created = [];
        const failures = [];
        for (const workspace of chosen) {
          const result = await requestTransfer(ctx, {
            sessionId: transferState.target.id,
            workspaceId: workspace.id,
            mode: 'copy',
          });
          if (result.ok) {
            created.push({ sessionId: String(result.value?.sessionId ?? ''), workspaceId: workspace.id, title: workspace.title });
          } else {
            failures.push(`${workspace.title}: ${result.error}`);
          }
        }
        setBusy(false);
        if (created.length === 0) {
          publishTransfer({ busy: false, error: `${tr('transferFailed')}${failures.join('; ')}` });
          return;
        }
        const text = created.length === 1
          ? `${tr('transferDoneCopy')} ${created[0].title}`
          : tr('transferCopiedMany').replace('{n}', String(created.length));
        finish({
          text: failures.length === 0 ? text : `${text} · ${tr('transferPartial').replace('{n}', String(failures.length))}`,
          tone: failures.length === 0 ? 'success' : 'warning',
          undo: { kind: 'copy', created },
        });
      };

      const toggle = (workspaceId) => {
        if (busy) return
        const next = state.picks.includes(workspaceId)
          ? state.picks.filter((id) => id !== workspaceId)
          : [...state.picks, workspaceId];
        publishTransfer({ picks: next, error: '' });
      };

      const rows = !choices.ready
        ? h('p', { className: 'ove-transfer-empty', role: 'status' }, tr('transferLoading'))
        : choices.targets.length === 0
          ? h('p', { className: 'ove-transfer-empty' }, tr('transferNoTargets'))
          : h('div', { className: `ove-transfer-list ${move ? 'move' : 'copy'}` }, choices.targets.map((workspace) => {
          const active = picked.includes(workspace.id);
          return h('button', {
            key: workspace.id,
            type: 'button',
            className: `ove-transfer-row${active ? ' picked' : ''}`,
            disabled: busy,
            'aria-pressed': active,
            onClick: () => { void (move ? runOne(workspace) : toggle(workspace.id)); },
          },
            h('span', {
              className: 'ove-transfer-check',
              'data-picked': active ? 'true' : 'false',
              'aria-hidden': 'true',
            }, active ? '✓' : ''),
            h('span', { className: 'ove-transfer-name' }, workspace.title),
            workspace.path.length > 0 && h('span', { className: 'ove-transfer-path' }, workspace.path));
        }));

      const dialog = h('div', {
        className: 'ove-dialog ove-transfer-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': tr(move ? 'transferMoveTitle' : 'transferCopyTitle'),
      },
        h('h2', { className: `ove-dialog-title ove-transfer-tone-${move ? 'move' : 'copy'}` }, tr(move ? 'transferMoveTitle' : 'transferCopyTitle')),
        h('p', { className: 'ove-dialog-desc' }, tr(move ? 'transferMoveDesc' : 'transferCopyDesc')),
        h('p', { className: 'ove-dialog-target' }, `${tr('transferOrigin')}${choices.origin}`),
        h('p', { className: 'ove-transfer-note' }, tr(move ? 'transferPick' : 'transferPickMany')),
        rows,
        state.error.length > 0 && h('p', { className: 'ove-error', role: 'alert' }, state.error),
        h('div', { className: 'ove-dialog-actions' },
          h('button', {
            type: 'button',
            className: 'ove-btn',
            disabled: busy,
            onClick: close,
          }, busy ? tr('transferBusy') : tr('transferClose')),
          !move && h('button', {
            type: 'button',
            className: 'ove-btn ove-btn-copy',
            disabled: busy || state.picks.length === 0,
            onClick: () => { void runMany(); },
          }, tr('transferCopyCount').replace('{n}', String(state.picks.length)))),
        h('p', { className: 'ove-transfer-note' }, tr('transferEmpty')));

      return overlayPortal(h(React.Fragment, null,
        // The dialog can open from the session menu before any other surface of
        // this plugin has mounted, so it always ships its own CSS.
        h('style', { key: 'styles', 'data-plugin-css': `${NS}-transfer` }, CSS),
        h('div', {
          className: 'ove-overlay ove-overlay-top',
          onMouseDown: (event) => { if (event.target === event.currentTarget) close(); },
        }, dialog)));
    }

    /**
     * Transient receipt for a finished transfer: a floating notice with an undo
     * action, mirroring the shipped archive notice instead of an inline box.
     * @param props - injected translator and the plugin context.
     * @returns the toast, or nothing while no receipt is pending.
     */
    function SessionTransferToast({ t, ctx }) {
      const tr = typeof t === 'function' ? t : (key) => key;
      const state = React.useSyncExternalStore(subscribeTransfer, getTransfer, getTransfer);
      const notice = state.notice;
      const [busy, setBusy] = React.useState(false);

      React.useEffect(() => {
        if (notice === null) return undefined;
        const timer = setTimeout(() => { publishTransfer({ notice: null }); }, 6000);
        return () => clearTimeout(timer);
      }, [notice]);

      if (notice === null) return null;

      const dismiss = () => { publishTransfer({ notice: null }); };
      const undoable = notice.undo !== null && notice.undo !== undefined
        && !(notice.undo.kind === 'move'
          && (notice.undo.sourceWorkspaceId ?? '').length === 0
          && (notice.undo.sourceCwd ?? '').length === 0);
      const undo = async () => {
        if (busy) return
        setBusy(true);
        const outcome = await undoTransfer(ctx, notice.undo);
        setBusy(false);
        if (outcome.ok) {
          transferNoticeSeq += 1;
          publishTransfer({
            notice: {
              seq: transferNoticeSeq,
              text: tr('transferUndone'),
              tone: 'success',
              undo: null,
            },
          });
        } else {
          transferNoticeSeq += 1;
          const reason = outcome.unavailable
            ? tr('transferUndoUnavailable')
            : outcome.error || tr('transferFailed');
          publishTransfer({
            notice: {
              seq: transferNoticeSeq,
              text: `${tr('transferUndoFailed')}${reason}`,
              tone: 'warning',
              undo: null,
            },
          });
        }
      };

      return overlayPortal(h(React.Fragment, null,
        h('style', { key: 'styles', 'data-plugin-css': `${NS}-toast` }, CSS),
        h('div', {
          key: notice.seq,
          className: `ove-toast ove-toast-${notice.tone === 'warning' ? 'warning' : 'success'}`,
          role: 'status',
        },
          h('span', { className: 'ove-toast-text' }, notice.text),
          notice.undo !== null && notice.undo !== undefined && undoable && h('button', {
            type: 'button',
            className: 'ove-toast-action',
            disabled: busy,
            onClick: () => { void undo(); },
          }, busy ? tr('transferBusy') : tr('transferUndo')),
          h('button', {
            type: 'button',
            className: 'ove-toast-close',
            'aria-label': tr('transferClose'),
            onClick: dismiss,
          }, '×'))));
    }

    /**
     * Receipt for a permanent deletion, carrying its undo. The Host has already
     * removed the session; the retained copy hands it back until the countdown
     * runs out, at which point the trash entry is dropped for good.
     * @param props - injected translator and the plugin context.
     * @returns the toast, or nothing while no receipt is pending.
     */
    function SessionDeleteToast({ t, ctx }) {
      const tr = typeof t === 'function' ? t : (key) => key;
      const notices = React.useSyncExternalStore(subscribeDeleteNotice, getDeleteNotices, getDeleteNotices);
      // A transfer receipt and deletion receipts can be on screen together; the
      // deletion ones step below so neither hides the other's undo.
      const transferNotice = React.useSyncExternalStore(subscribeTransfer, getTransfer, getTransfer).notice;
      const shifted = transferNotice !== null && transferNotice !== undefined;

      if (notices.length === 0) return null;

      return overlayPortal(h(React.Fragment, null,
        h('style', { key: 'styles', 'data-plugin-css': `${NS}-delete-toast` }, CSS),
        notices.map((notice, index) => h(DeleteNoticeToast, {
          key: notice.seq,
          notice,
          index,
          shifted,
          t,
          ctx,
        }))));
    }

    /**
     * One deletion receipt: its own countdown, its own undo. A separate
     * component so two deletions in a row each keep a working timer.
     * @param props - the receipt, its stack position, translator and context.
     * @returns the toast.
     */
    function DeleteNoticeToast({ notice, index, shifted, t, ctx }) {
      const tr = typeof t === 'function' ? t : (key) => key;
      const [busy, setBusy] = React.useState(false);
      const [remaining, setRemaining] = React.useState(typeof notice.seconds === 'number' ? notice.seconds : 10);
      const token = typeof notice.token === 'string' ? notice.token : '';
      const seconds = typeof notice.seconds === 'number' ? notice.seconds : 10;

      React.useEffect(() => {
        if (token.length === 0) return undefined;
        setRemaining(seconds);
        const tick = window.setInterval(() => {
          setRemaining(value => (value > 0 ? value - 1 : 0));
        }, 1000);
        const timer = window.setTimeout(() => {
          void requestPurge(token);
          dismissDeleteNotice(notice.seq);
        }, seconds * 1000);
        return () => {
          window.clearInterval(tick);
          window.clearTimeout(timer);
        };
      }, [notice.seq, token, seconds]);

      // A receipt without an undo (the outcome of an undo, or a failure) is a
      // plain notice and clears itself.
      React.useEffect(() => {
        if (token.length > 0) return undefined;
        const timer = window.setTimeout(() => dismissDeleteNotice(notice.seq), 4000);
        return () => window.clearTimeout(timer);
      }, [notice.seq, token]);

      const undo = async () => {
        if (busy || token.length === 0) return;
        setBusy(true);
        const outcome = await requestRestore(ctx, token);
        setBusy(false);
        dismissDeleteNotice(notice.seq);
        pushDeleteNotice({
          text: outcome.ok ? tr('deleteUndone') : `${tr('deleteUndoFailed')}${outcome.error}`,
          tone: outcome.ok ? 'success' : 'warning',
          token: '',
          seconds: 0,
        });
      };

      return h('div', {
        className: `ove-toast ove-toast-${notice.tone === 'warning' ? 'warning' : 'success'}`,
        // Stack: the transfer receipt owns the top slot, deletions queue under it.
        style: { top: `${24 + (shifted ? 44 : 0) + index * 52}px` },
        role: 'status',
      },
        h('span', { className: 'ove-toast-text' }, notice.text),
        token.length > 0 && h('span', { className: 'ove-toast-count' },
          tr('deleteUndoSeconds').replace('{n}', String(remaining))),
        token.length > 0 && h('button', {
          type: 'button',
          className: 'ove-toast-action',
          disabled: busy,
          onClick: () => { void undo(); },
        }, busy ? tr('restoring') : tr('deleteUndo')),
        h('button', {
          type: 'button',
          className: 'ove-toast-close',
          'aria-label': tr('transferClose'),
          // Closing the receipt means "do not undo this": the retained copy is
          // dropped now instead of waiting for the Host's sweep.
          onClick: () => {
            if (token.length > 0) void requestPurge(token);
            dismissDeleteNotice(notice.seq);
          },
        }, '×'));
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

      const actions = h('div', { className: 'ove-dialog-actions' },
        h('button', {
          type: 'button',
          className: 'ove-btn',
          ref: cancelRef,
          disabled: busy,
          onClick: onCancel,
        }, tr('cancel')),
        canForce && h('button', {
          type: 'button',
          className: 'ove-btn',
          disabled: busy,
          onClick: () => onConfirm(false),
        }, tr('retryDelete')),
        h('button', {
          type: 'button',
          className: 'ove-btn ove-btn-danger',
          disabled: busy,
          onClick: () => onConfirm(canForce),
        }, busy ? tr('deleting') : canForce ? tr('forceDelete') : tr('confirmDelete')));

      const dialog = h('div', {
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
        canForce && h('p', { className: 'ove-muted ove-dialog-note' }, tr('retryHint')),
        actions);

      return overlayPortal(h(React.Fragment, null,
        // The dialog can be opened from the session menu before any other
        // surface of this plugin has mounted, so it always ships its own CSS.
        h('style', { key: 'styles', 'data-plugin-css': `${NS}-delete` }, CSS),
        h('div', {
          className: `ove-overlay ${overlayClass ?? 'ove-overlay-top'}`.trim(),
          onMouseDown: (event) => { if (event.target === event.currentTarget) onCancel(); },
        }, dialog)));
    }

    /**
     * Session-menu deletion confirmation bound to the shared pending target.
     * @param props - injected translator and the plugin context.
     * @returns the confirmation overlay, or nothing while no target is pending.
     */
    function DeleteDialog({ t, ctx }) {
      const tr = typeof t === 'function' ? t : (key) => key;
      const state = React.useSyncExternalStore(subscribeDelete, getDelete, getDelete);
      if (state.target === null) return null;

      const cancel = () => {
        if (deleteState.busy) return;
        publishDelete({ target: null, busy: false, error: '', code: '' });
      };
      const confirm = async (force) => {
        // Read the shared state, not this render's snapshot: a double click
        // must not start a second request that then overwrites the outcome.
        const target = deleteState.target;
        if (target === null || deleteState.busy) return;
        publishDelete({ busy: true, error: '', code: '' });
        const result = await requestDelete(ctx, target, force);
        if (result.ok) {
          publishDelete({ target: null, busy: false, error: '', code: '' });
          // Same receipt the archive page publishes: deleting from the sidebar
          // menu is undoable too.
          pushDeleteNotice({
            text: `${tr('delete')} · ${target.title}`,
            tone: 'success',
            token: result.token ?? '',
            seconds: 10,
          });
        } else {
          publishDelete({ busy: false, error: result.error, code: result.code });
        }
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
    /* Automation task enhancements                                        */
    /* ------------------------------------------------------------------ */

    const AUTOMATION_PANEL = 'original-version-enhancements.automation';

    /**
     * Call one Host automation route.
     * @param segment - route segment below /automation.
     * @param payload - JSON request body.
     * @returns `{ok, value}` or `{ok:false, error, code}`.
     */
    const automationCall = async (segment, payload) => {
      try {
        const response = await fetch(`${ROUTE_ROOT}/automation/${segment}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
        });
        const body = await readJson(response);
        if (!response.ok || body?.ok !== true) {
          return {
            ok: false,
            error: body?.error?.message || describeHttpStatus(response.status),
            code: typeof body?.error?.code === 'string' ? body.error.code : '',
          };
        }
        return { ok: true, value: body.value };
      } catch (error) {
        return { ok: false, error: describeRequestFailure(error), code: '' };
      }
    };

    /**
     * Local date-time label for a stored instant.
     * @param value - ISO timestamp or undefined.
     * @returns a short human label, or an empty string.
     */
    const formatInstant = (value) => {
      if (typeof value !== 'string' || value.length === 0) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return date.toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    };

    /**
     * Relative distance label the page appends to the next occurrence.
     * @param value - ISO timestamp.
     * @param tr - translator.
     * @param now - epoch milliseconds of the current tick.
     * @returns a relative label, or an empty string when it is in the past.
     */
    const relativeTo = (value, tr, now) => {
      const time = Date.parse(value ?? '');
      if (Number.isNaN(time)) return '';
      const seconds = Math.round((time - (now ?? Date.now())) / 1000);
      if (seconds < 1) return '';
      if (seconds < 60) return tr('auto.inSeconds').replace('{n}', String(seconds));
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return tr('auto.inMinutes').replace('{n}', String(minutes));
      const hours = Math.round(minutes / 60);
      if (hours < 24) return tr('auto.inHours').replace('{n}', String(hours));
      return tr('auto.inDays').replace('{n}', String(Math.round(hours / 24)));
    };

    const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

    /** RFC 5545 weekday codes, in the panel's Sunday-first numbering. */
    const BYDAY_KEYS = { MO: 'mon', TU: 'tue', WE: 'wed', TH: 'thu', FR: 'fri', SA: 'sat', SU: 'sun' };

    /** The `RRULE` fields of one stored rule, or an empty map. */
    const ruleFieldsOf = (text) => {
      const line = /^RRULE:(.+)$/m.exec(typeof text === 'string' ? text : '')?.[1] ?? '';
      return new Map(line.split(';').filter((field) => field.includes('=')).map((field) => {
        const at = field.indexOf('=');
        return [field.slice(0, at).trim().toUpperCase(), field.slice(at + 1).trim().toUpperCase()];
      }));
    };

    /**
     * Which guided repeat choice one stored RRULE encodes.
     *
     * The stock Automation page stores every guided choice as an `rrule` record,
     * so this mirrors its classifier (`hostFrequencyKind`): a rule earns a name
     * only when it round-trips through the guided form, and anything else stays
     * "custom".
     * @param rule - stored DTSTART/RRULE content lines.
     * @returns once | minutely | hourly | daily | weekly | monthly | custom.
     */
    const rruleKindOf = (rule) => {
      const text = typeof rule === 'string' ? rule : '';
      const anchor = /^DTSTART(?:;TZID=[^:]+)?:\d{8}T\d{4}(\d{2})Z?$/m.exec(text);
      if (anchor === null) return 'custom';
      const fields = ruleFieldsOf(text);
      const frequency = fields.get('FREQ');
      if (fields.get('COUNT') === '1' && fields.size === 2 && frequency === 'DAILY') return 'once';
      if (fields.has('COUNT') || fields.has('UNTIL') || fields.has('BYSECOND')) return 'custom';
      const keys = [...fields.keys()];
      const allowed = (names) => keys.every((key) => names.includes(key));
      if (frequency === 'MINUTELY' && allowed(['FREQ', 'INTERVAL'])) return 'minutely';
      if (frequency === 'HOURLY' && allowed(['FREQ', 'INTERVAL'])) return 'hourly';
      if (frequency === 'DAILY' && anchor[1] === '00'
        && allowed(['FREQ', 'INTERVAL', 'BYHOUR', 'BYMINUTE', 'BYSETPOS'])
        && ((!fields.has('BYHOUR') && !fields.has('BYMINUTE') && !fields.has('BYSETPOS'))
          || (/^\d{1,2}$/.test(fields.get('BYHOUR') ?? '')
            && /^\d{1,2}$/.test(fields.get('BYMINUTE') ?? '')
            && (!fields.has('BYSETPOS') || fields.get('BYSETPOS') === '1')))) return 'daily';
      if (frequency === 'WEEKLY' && allowed(['FREQ', 'INTERVAL', 'BYDAY'])
        && (fields.get('BYDAY') ?? '').split(',').every((day) => /^(MO|TU|WE|TH|FR|SA|SU)$/.test(day))) return 'weekly';
      if (frequency === 'MONTHLY' && allowed(['FREQ', 'INTERVAL', 'BYMONTHDAY', 'BYSETPOS'])
        && fields.get('BYSETPOS') === '1'
        && /^\d{1,2},-1$/.test(fields.get('BYMONTHDAY') ?? '')) return 'monthly';
      return 'custom';
    };

    /**
     * Row summary of a task stored as an `rrule`.
     * @param task - one automation row.
     * @param tr - translator.
     * @returns the localized rule summary.
     */
    const rruleSummaryOf = (task, tr) => {
      const kind = rruleKindOf(task.rrule);
      if (kind === 'custom') return tr('auto.custom');
      if (kind === 'once') return tr('auto.once');
      const fields = ruleFieldsOf(task.rrule);
      const interval = Math.max(1, Number(fields.get('INTERVAL') ?? 1) || 1);
      const clock = /T(\d{6})/.exec(task.rrule)?.[1] ?? '000000';
      const time = `${String(Number(fields.get('BYHOUR') ?? clock.slice(0, 2))).padStart(2, '0')}:${String(Number(fields.get('BYMINUTE') ?? clock.slice(2, 4))).padStart(2, '0')}`;
      if (kind === 'minutely') {
        return interval >= 60 && interval % 60 === 0
          ? tr('auto.everyHour').replace('{n}', String(interval / 60))
          : tr('auto.every').replace('{n}', String(interval));
      }
      if (kind === 'hourly') return tr('auto.everyHour').replace('{n}', String(interval));
      if (kind === 'daily') {
        return `${interval === 1 ? tr('auto.daily') : tr('auto.everyDay').replace('{n}', String(interval))} ${time}`.trim();
      }
      if (kind === 'weekly') {
        const names = (fields.get('BYDAY') ?? '').split(',')
          .map((day) => tr(`auto.weekday.${BYDAY_KEYS[day] ?? 'mon'}`))
          .join('、');
        return `${interval === 1 ? tr('auto.weekly') : tr('auto.everyWeek').replace('{n}', String(interval))} ${names} ${time}`.trim();
      }
      const monthDay = Number((fields.get('BYMONTHDAY') ?? '1').split(',')[0]) || 1;
      const key = interval === 1 ? 'auto.monthly' : 'auto.everyMonth';
      return tr(key)
        .replace('{n}', String(interval))
        .replace('{day}', String(monthDay))
        .replace('{time}', time);
    };

    /** Ready-made RRULE bodies offered under the custom-rule editor. */
    const RRULE_EXAMPLES = [
      { body: 'FREQ=WEEKLY;BYDAY=MO,WE,FR', label: 'auto.ruleEx1' },
      { body: 'FREQ=DAILY;INTERVAL=2', label: 'auto.ruleEx2' },
      { body: 'FREQ=MONTHLY;BYMONTHDAY=1', label: 'auto.ruleEx3' },
    ];

    /**
     * Recurrence description shown on a row, mirroring the stock page wording.
     * @param task - one automation row.
     * @param tr - translator.
     * @returns the localized rule summary.
     */
    const recurrenceOf = (task, tr) => {
      switch (task.kind) {
        case 'at':
          return tr('auto.once');
        case 'after':
          return tr('auto.after').replace('{n}', String(Math.round((task.afterSeconds ?? 0) / 60)));
        case 'every': {
          const seconds = task.everySeconds ?? 0;
          return seconds >= 3600 && seconds % 3600 === 0
            ? tr('auto.everyHour').replace('{n}', String(Math.round(seconds / 3600)))
            : tr('auto.every').replace('{n}', String(Math.round(seconds / 60)));
        }
        case 'daily':
          return `${tr('auto.daily')} ${String(task.time ?? '').slice(0, 5)}`.trim();
        case 'weekly':
          return `${tr('auto.weekly')} ${(task.weekdays ?? []).map((day) => tr(`auto.weekday.${WEEKDAY_KEYS[day] ?? 'mon'}`)).join('、')} ${String(task.time ?? '').slice(0, 5)}`.trim();
        case 'cron': {
          const expression = typeof task.expression === 'string' ? task.expression.trim() : '';
          return expression.length > 0 ? tr('auto.cronSummary').replace('{expr}', expression) : tr('auto.custom');
        }
        case 'rrule':
          return rruleSummaryOf(task, tr);
        default:
          return tr('auto.custom');
      }
    };

    const ClockMark = ({ size }) => h('svg', {
      viewBox: '0 0 16 16',
      width: size ?? 18,
      height: size ?? 18,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.3,
      strokeLinecap: 'round',
      'aria-hidden': 'true',
    },
    h('circle', { cx: 8, cy: 8, r: 6 }),
    h('path', { d: 'M8 4.7V8l2.3 1.5' }));

    const EmptyArt = () => h('svg', {
      viewBox: '0 0 96 96',
      width: 96,
      height: 96,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
    h('path', { d: 'M24 18h34l14 14v46a4 4 0 0 1-4 4H24a4 4 0 0 1-4-4V22a4 4 0 0 1 4-4z' }),
    h('path', { d: 'M58 18v14h14' }),
    h('path', { d: 'M31 40h22M31 50h22M31 60h14' }),
    h('circle', { cx: 64, cy: 66, r: 15 }),
    h('path', { d: 'M64 59v7l5 3' }));

    const timeZone = () => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      } catch {
        return 'UTC';
      }
    };

    const localDate = () => {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    };

    /** Local `YYYY-MM-DD` of one instant. */
    const dateOf = (when) => `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;

    /** Local `HH:mm:ss` of one instant. */
    const clockOf = (when) => `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}:${String(when.getSeconds()).padStart(2, '0')}`;

    /**
     * Normalise a stored clock to `HH:mm:ss`.
     *
     * The Host stores `time` as a full clock and with millisecond precision
     * (`09:00:00.000`), which the `<input type="time">` element and the Host's own
     * `HH:mm[:ss]` request validator both reject. Truncating to seconds here is
     * what keeps a daily/weekly task editable at all.
     * @param value - stored clock, `HH:mm` or longer.
     * @returns the padded `HH:mm:ss` clock, or the input unchanged.
     */
    const withSeconds = (value) => {
      if (typeof value !== 'string') return value;
      const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(value.trim());
      if (match === null) return value;
      return `${match[1].padStart(2, '0')}:${match[2]}:${match[3] ?? '00'}`;
    };

    /** `HHmmss` body for an RRULE `DTSTART`. */
    const rruleClock = (value) => withSeconds(value).replace(/:/g, '');

    /** The `BYMONTHDAY` day of a monthly rule, or 1. */
    const monthDayOf = (rule) => {
      const match = /BYMONTHDAY=(\d+)/i.exec(typeof rule === 'string' ? rule : '');
      const day = match === null ? Number.NaN : Number(match[1]);
      return Number.isFinite(day) && day >= 1 && day <= 31 ? day : 1;
    };

    /** Weekday codes a "workdays" rule must contain — exactly, not as a substring. */
    const WORKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR'];

    /**
     * The clauses of a rule's single `RRULE` line, or null when the text holds
     * anything the guided forms cannot reproduce.
     *
     * The guided forms rebuild the rule from a few fields, so they may only
     * claim a rule whose whole meaning lies in those fields: reaching
     * `weekdays` with an `INTERVAL=2` rule silently turned "every other week"
     * into "every week", and an `UNTIL` rule never ends.
     * @param rule - the RRULE text.
     * @returns a key→value map (upper-cased), or null when not a single rule.
     */
    const rruleClausesOf = (rule) => {
      if (typeof rule !== 'string') return null;
      const lines = rule.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
      if (lines.some(line => !/^(RRULE|DTSTART)([;:])/i.test(line))) return null;
      const starts = lines.filter(line => /^DTSTART([;:])/i.test(line)).length;
      const bodies = lines.filter(line => /^RRULE:/i.test(line));
      if (starts > 1 || bodies.length !== 1) return null;
      const clauses = new Map();
      for (const part of bodies[0].replace(/^RRULE:/i, '').split(';')) {
        const at = part.indexOf('=');
        if (at <= 0) return null;
        const key = part.slice(0, at).trim().toUpperCase();
        if (clauses.has(key)) return null;
        clauses.set(key, part.slice(at + 1).trim().toUpperCase());
      }
      return clauses;
    };

    /**
     * Whether a rule only carries clauses a guided form faithfully rebuilds.
     * `INTERVAL=1` is allowed (dropping it changes the text, not the schedule).
     * @param clauses - the parsed clauses.
     * @param allowed - the clause names the guided form understands.
     * @returns true when nothing else is present and the interval is 1.
     */
    const isPlainRule = (clauses, allowed) => {
      if (clauses === null) return false;
      if ([...clauses.keys()].some(key => key !== 'INTERVAL' && !allowed.includes(key))) return false;
      return !clauses.has('INTERVAL') || clauses.get('INTERVAL') === '1';
    };

    /**
     * The `BYDAY` codes of a rule, upper-cased.
     *
     * A substring test matched `…,FR,SA` as well, so a six-day weekly rule was
     * presented (and saved) as Monday-to-Friday: the comparison has to be on the
     * parsed set.
     * @param rule - the RRULE text.
     * @returns the day codes in the rule.
     */
    const byDayOf = (rule) => {
      const match = /BYDAY=([^;\s]+)/i.exec(typeof rule === 'string' ? rule : '');
      if (match === null) return [];
      return match[1].split(',').map(code => code.trim().toUpperCase()).filter(code => code.length > 0);
    };

    /**
     * Whether a rule repeats on exactly the five workdays.
     * @param rule - the RRULE text.
     * @returns true when the rule is a plain weekly rule on exactly MO–FR.
     */
    const isWorkdayRule = (rule) => {
      const clauses = rruleClausesOf(rule);
      if (clauses === null || clauses.get('FREQ') !== 'WEEKLY') return false;
      if (!isPlainRule(clauses, ['FREQ', 'BYDAY'])) return false;
      const days = byDayOf(rule);
      if (days.length !== WORKDAYS.length) return false;
      const unique = new Set(days);
      return unique.size === WORKDAYS.length && WORKDAYS.every(code => unique.has(code));
    };

    /**
     * Whether a rule repeats monthly on one day of the month.
     * @param rule - the RRULE text.
     * @returns true when the rule is a plain monthly rule with `BYMONTHDAY`.
     */
    const isMonthlyRule = (rule) => {
      const clauses = rruleClausesOf(rule);
      if (clauses === null || clauses.get('FREQ') !== 'MONTHLY') return false;
      if (!clauses.has('BYMONTHDAY')) return false;
      return isPlainRule(clauses, ['FREQ', 'BYMONTHDAY']);
    };

    /**
     * The `DTSTART` a rule carries, as an editor date and clock.
     *
     * Editing a derived rule used to rebuild `DTSTART` from "now + 30 minutes",
     * so merely opening and saving a workday or monthly task moved it to a new
     * time of day. The stored start is the only value that round-trips.
     * @param rule - the RRULE text.
     * @returns `{date, time}` in editor form, or undefined when the rule has none.
     */
    const ruleStartOf = (rule) => {
      const match = /DTSTART(?:;TZID=[^:\n]+)?:(\d{8})T(\d{4,6})/i.exec(typeof rule === 'string' ? rule : '');
      if (match === null) return undefined;
      const [, date, clock] = match;
      return {
        date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
        time: `${clock.slice(0, 2)}:${clock.slice(2, 4)}:${clock.slice(4, 6) ?? '00'}`,
      };
    };

    /**
     * Which repeat choice in the editor describes one stored task.
     *
     * A cron task keeps its cron form: presenting it as an RRULE would show a
     * fabricated rule and silently rewrite the expression on save.
     * @param task - one catalog row, or null.
     * @returns the editor kind.
     */
    const repeatKindOf = (task) => {
      const kind = typeof task?.kind === 'string' ? task.kind : 'every';
      const rule = typeof task?.rrule === 'string' ? task.rrule : '';
      if (kind === 'after') return 'delay';
      if (kind === 'at') return 'once';
      if (kind === 'every') {
        const seconds = typeof task.everySeconds === 'number' ? task.everySeconds : 0;
        return seconds >= 3600 && seconds % 3600 === 0 ? 'hourly' : 'minutely';
      }
      if (kind === 'daily') return 'daily';
      if (kind === 'weekly') return 'weekly';
      if (kind === 'cron') return 'cron';
      if (kind === 'rrule') {
        if (isWorkdayRule(rule)) return 'weekdays';
        if (isMonthlyRule(rule)) return 'monthly';
        return 'rrule';
      }
      return 'minutely';
    };

    /**
     * Build the initial editor draft for a new task or an existing row.
     * @param task - the row being edited, or null for a new task.
     * @param cleanFlags - the Host auto-clean map, keyed by task identity.
     * @returns the draft.
     */
    const draftOf = (task, cleanFlags) => {
      const target = task?.target ?? { kind: 'new_once' };
      const kind = task === null || task === undefined ? 'delay' : repeatKindOf(task);
      const soon = new Date(Date.now() + 30 * 60 * 1000);
      const at = typeof task?.scheduledAt === 'string' ? new Date(task.scheduledAt) : null;
      const atValid = at !== null && Number.isFinite(at.getTime());
      const delayMinutes = () => {
        if (typeof task?.afterSeconds === 'number' && task.afterSeconds > 0) {
          return String(Math.max(1, Math.round(task.afterSeconds / 60)));
        }
        if (atValid) return String(Math.max(1, Math.round((at.getTime() - Date.now()) / 60000)));
        return '30';
      };
      // A delay that is not a whole number of minutes keeps its seconds:
      // rounding 90 s up to 2 min silently changed when the task ran.
      const exactSeconds = typeof task?.afterSeconds === 'number' && task.afterSeconds > 0
        && task.afterSeconds % 60 !== 0;
      const delayInSeconds = exactSeconds;
      const everySeconds = typeof task?.everySeconds === 'number' && task.everySeconds > 0 ? task.everySeconds : 1800;
      const intervalOf = () => {
        if (kind === 'delay') return delayInSeconds ? String(Math.round(task.afterSeconds)) : delayMinutes();
        if (kind === 'hourly') return String(Math.max(1, Math.round(everySeconds / 3600)));
        return String(Math.max(1, Math.round(everySeconds / 60)));
      };
      // Every stored weekday travels with the draft: a weekly task on Mon+Thu used
      // to be edited — and saved — as Monday only.
      const days = Array.isArray(task?.weekdays)
        ? [...new Set(task.weekdays.filter(day => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b)
        : [];
      const weekdays = days.length > 0 ? days : [1];
      // A rule-derived editor keeps the rule's own DTSTART. Rebuilding it from
      // "now + 30 minutes" moved every workday/monthly task on save.
      const ruleStart = kind === 'weekdays' || kind === 'monthly' || kind === 'rrule'
        ? ruleStartOf(task?.rrule)
        : undefined;
      const draft = {
        id: task?.id ?? '',
        title: task?.title ?? '',
        prompt: task?.prompt ?? '',
        kind,
        interval: intervalOf(),
        delayUnit: delayInSeconds ? 'sec' : 'min',
        date: atValid && kind === 'once' ? dateOf(at) : (ruleStart?.date ?? dateOf(soon)),
        time: atValid && kind === 'once'
          ? clockOf(at)
          : (ruleStart?.time ?? (typeof task?.time === 'string' ? withSeconds(task.time) : clockOf(soon))),
        weekday: weekdays[0],
        weekdays,
        monthDay: `${monthDayOf(task?.rrule)}`,
        rrule: task?.rrule ?? `DTSTART;TZID=${timeZone()}:${dateOf(soon).replace(/-/g, '')}T${rruleClock(clockOf(soon))}\nRRULE:FREQ=WEEKLY;BYDAY=MO`,
        cron: typeof task?.expression === 'string' && task.expression.length > 0 ? task.expression : '0 9 * * *',
        targetKind: target.kind === 'session' ? 'session' : target.kind === 'new' ? 'new' : 'new_once',
        sessionId: target.kind === 'session' ? target.sessionId : '',
        cwd: target.cwd ?? '',
        // Kept so saving an edit cannot silently drop the preset the task was
        // created with.
        agentPreset: typeof target.agentPreset === 'string' ? target.agentPreset : '',
        autoClean: task !== null && task !== undefined && cleanFlags !== undefined
          && cleanFlags[task.id] === true,
        // `paused` means "do not run", `active` means "running", and `ended` is a
        // terminal state that must not be re-armed by an ordinary edit.
        active: task === null || task === undefined
          ? true
          : task.status === 'paused' ? false : task.status === 'active' ? true : undefined,
        // The revision this draft was rendered from, for the Host's conflict check.
        updatedAt: typeof task?.updatedAt === 'string' ? task.updatedAt : null,
      };
      return draft;
    };

    /**
     * Fields that always describe the task, independent of the repeat kind.
     */
    const DRAFT_IDENTITY_FIELDS = [
      'title', 'prompt', 'kind', 'targetKind', 'sessionId', 'cwd', 'agentPreset',
    ];

    /**
     * The timing fields one repeat kind actually edits. Comparing the whole
     * draft would make the comparison depend on "now" (a delay draft carries an
     * untouched date/time that `draftOf` recomputes), which would block the
     * harmless revision adoption this check exists to allow.
     */
    const DRAFT_TIMING_FIELDS = {
      delay: ['interval', 'delayUnit'],
      minutely: ['interval'],
      hourly: ['interval'],
      daily: ['time'],
      weekly: ['weekdays', 'time'],
      weekdays: ['date', 'time'],
      monthly: ['date', 'time', 'monthDay'],
      once: ['date', 'time'],
      rrule: ['rrule'],
      cron: ['cron'],
    };

    /**
     * Whether two drafts agree on the task's run state.
     *
     * A pause or resume made in another window bumps the revision without
     * touching any edited field; adopting it kept the stale `active` and the
     * next save flipped the other window's choice back. `undefined` means "no
     * opinion" (an ended task), so it never counts as a disagreement.
     * @param left - the open draft.
     * @param right - a draft rebuilt from the current row.
     * @returns true when both agree, or when at least one has no opinion.
     */
    const sameRunState = (left, right) => {
      const runnable = (value) => value === true || value === false;
      if (!runnable(left?.active) || !runnable(right?.active)) return true;
      return left.active === right.active;
    };

    /**
     * Whether two drafts describe the same stored task.
     *
     * Adopting a newer revision is only safe when the row still holds exactly
     * what the drawer is showing: a title or timing edit made elsewhere must
     * reach the save as a conflict instead of being silently overwritten.
     * @param left - the open draft.
     * @param right - a draft rebuilt from the current row.
     * @returns true when every edited field matches.
     */
    const sameDraftContent = (left, right) => {
      if (left?.kind !== right?.kind) return false;
      if (!sameRunState(left, right)) return false;
      const fields = [...DRAFT_IDENTITY_FIELDS, ...(DRAFT_TIMING_FIELDS[left.kind] ?? [])];
      return fields.every(field => (
        JSON.stringify(left?.[field] ?? null) === JSON.stringify(right?.[field] ?? null)
      ));
    };

    /**
     * Turn an editor draft into a Host timing request.
     * @param draft - editor draft.
     * @returns the timing request, or undefined when the draft is invalid.
     */
    const timingOfDraft = (draft) => {
      const zone = timeZone();
      const count = Number(draft.interval);
      const valid = Number.isFinite(count) && count >= 1;
      const stamp = `DTSTART;TZID=${zone}:${draft.date.replace(/-/g, '')}T${rruleClock(draft.time)}`;
      switch (draft.kind) {
        case 'delay':
          return valid
            ? { kind: 'after', after_seconds: Math.round(draft.delayUnit === 'sec' ? count : count * 60) }
            : undefined;
        case 'minutely':
          return valid ? { kind: 'every', every_seconds: Math.round(count * 60) } : undefined;
        case 'hourly':
          return valid ? { kind: 'every', every_seconds: Math.round(count * 3600) } : undefined;
        case 'daily':
          return { kind: 'daily', daily: { time: withSeconds(draft.time), time_zone: zone } };
        case 'weekly': {
          // Every selected day is kept. An empty selection used to fall back to
          // `draft.weekday` — the day the drawer opened on — so clearing the
          // picker saved the one day the human had just removed. Monday is the
          // documented fallback.
          const days = Array.isArray(draft.weekdays) && draft.weekdays.length > 0
            ? [...new Set(draft.weekdays.filter(day => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b)
            : [1];
          return { kind: 'weekly', weekly: { time: withSeconds(draft.time), time_zone: zone, weekdays: days.length > 0 ? days : [1] } };
        }
        case 'weekdays':
          return { kind: 'rrule', rrule: `${stamp}\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR` };
        case 'monthly': {
          const day = Number(draft.monthDay);
          if (!Number.isFinite(day) || day < 1 || day > 31) return undefined;
          return { kind: 'rrule', rrule: `${stamp}\nRRULE:FREQ=MONTHLY;BYMONTHDAY=${Math.round(day)}` };
        }
        case 'once': {
          const when = new Date(`${draft.date}T${withSeconds(draft.time)}`);
          if (!Number.isFinite(when.getTime())) return undefined;
          return { kind: 'at', at: when.toISOString() };
        }
        case 'rrule':
          return draft.rrule.trim().length > 0 ? { kind: 'rrule', rrule: draft.rrule } : undefined;
        case 'cron': {
          const expression = typeof draft.cron === 'string' ? draft.cron.trim() : '';
          // Five to seven whitespace-separated fields, the shape every cron
          // evaluator the Host accepts understands.
          if (expression.split(/\s+/).filter((part) => part.length > 0).length < 5) return undefined;
          return { kind: 'cron', cron: { expression, time_zone: zone } };
        }
        default:
          return undefined;
      }
    };

    const targetOfDraft = (draft) => {
      if (draft.targetKind === 'session') {
        if (typeof draft.sessionId !== 'string' || draft.sessionId.length === 0) return undefined;
        return { kind: 'session', sessionId: draft.sessionId };
      }
      const target = draft.cwd.length > 0
        ? { kind: draft.targetKind, cwd: draft.cwd }
        : { kind: draft.targetKind };
      // The Host keeps this in `target.create`; dropping it silently reset a task
      // to the default persona on every edit.
      if (typeof draft.agentPreset === 'string' && draft.agentPreset.length > 0) {
        target.agentPreset = draft.agentPreset;
      }
      return target;
    };

    /**
     * One conversation as "workspace/name", with the workspace half emphasised.
     * @param session - an entry carrying `workspace`, `label` and `archived`.
     * @param tr - translator, for the archived suffix.
     * @param showId - append the short session id, for rows that share a name.
     * @returns the nodes to render inside a row or trigger.
     */
    const sessionNodes = (session, tr, showId = false) => [
      session.workspace
        ? h('span', { className: 'ove-session-ws', key: 'workspace' }, session.workspace)
        : null,
      session.workspace ? h('span', { className: 'ove-session-sep', key: 'separator' }, '/') : null,
      h('span', { className: 'ove-session-name', key: 'name' }, session.label),
      showId
        ? h('span', { className: 'ove-session-id', key: 'id' }, `#${sessionIdTail(session.id)}`)
        : null,
      session.archived
        ? h('span', { className: 'ove-session-tag', key: 'tag' }, `（${tr('auto.archived')}）`)
        : null,
    ];

    /**
     * The distinguishable part of a session id: enough to tell two rows with
     * the same workspace and name apart without printing the whole uuid.
     * @param id - the session id.
     * @returns the first eight uuid characters.
     */
    const sessionIdTail = (id) => String(id).replace(/^session-/u, '').slice(0, 8);

    /**
     * Ids whose workspace + name pair repeats inside one list.
     * @param list - session entries carrying `id`, `workspace` and `label`.
     * @returns the ids that need the short-id suffix.
     */
    const duplicateIdsOf = (list) => {
      const counts = new Map();
      for (const session of list) {
        const key = `${session.workspace ?? ''}\u0000${session.label}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const ids = new Set();
      for (const session of list) {
        if ((counts.get(`${session.workspace ?? ''}\u0000${session.label}`) ?? 0) > 1) ids.add(session.id);
      }
      return ids;
    };

    /**
     * `CSS.escape` when the page provides it, for building attribute selectors
     * out of ids that may carry punctuation.
     * @param value - the raw attribute value.
     * @returns the value safe to interpolate into a selector.
     */
    const cssEscape = (value) => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(value)
      : String(value).replace(/["\\]/gu, '\\$&'));

    /**
     * The same pair as one plain string, for titles and failure messages.
     * @param session - an entry carrying `workspace` and `label`.
     * @returns "workspace/name", or just the name when the workspace is unknown.
     */
    const sessionPathText = (session) => {
      const workspace = typeof session?.workspace === 'string' ? session.workspace : '';
      const label = String(session?.label ?? '');
      // A candidate without a workspace (its id has no owner yet) used to throw
      // here, taking the whole combobox down with it.
      return workspace.length > 0 ? `${workspace}/${label}` : label;
    };

    /**
     * Whether a sidebar row is actually on screen: laid out, and intersecting
     * both the viewport and the scroll box that holds it.
     * @param node - the session row in the workspace list.
     * @returns true when the row can be seen.
     */
    const rowIsVisible = (node) => {
      const box = node.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return false;
      let reachTop = 0;
      let reachBottom = window.innerHeight;
      let parent = node.parentElement;
      while (parent !== null && parent !== document.body) {
        const style = window.getComputedStyle(parent);
        if (/(auto|scroll|overlay)/u.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) {
          const frame = parent.getBoundingClientRect();
          reachTop = Math.max(reachTop, frame.top);
          reachBottom = Math.min(reachBottom, frame.bottom);
          break;
        }
        parent = parent.parentElement;
      }
      return box.bottom > reachTop && box.top < reachBottom;
    };

    /**
     * Conversation combobox for the automation drawer. A native <select> can
     * neither emphasise the workspace half nor react to the pointer moving
     * through the options, so it is rebuilt here: every row reads
     * "workspace/name", conversations sharing a title stay separate, and
     * moving over one outlines its row in the workspace list.
     * @param props - options, the chosen session id, and the change handler.
     * @returns the trigger button and its portalled list.
     */
    function SessionPicker({ options, value, onChange, tr }) {
      const [open, setOpen] = React.useState(false);
      const [cursor, setCursor] = React.useState(-1);
      const [box, setBox] = React.useState(null);
      const buttonRef = React.useRef(null);
      const listRef = React.useRef(null);
      // Workspaces this opening expanded, each mapped to the state the human
      // last chose. Re-entering one is skipped so a manual collapse is not
      // fought by the next hover, and closing without a choice walks the map
      // to put the sidebar back exactly as they left it.
      const expandedRef = React.useRef(new Map());

      const selectedIndex = options.findIndex((option) => option.id === value);
      const selected = selectedIndex >= 0 ? options[selectedIndex] : null;
      const active = open && cursor >= 0 && cursor < options.length ? options[cursor] : null;
      const duplicates = React.useMemo(() => duplicateIdsOf(options), [options]);
      // Stable ids let a screen reader follow the highlighted row even though
      // focus stays on the combobox button (the list itself is portalled).
      const listId = React.useId();
      const optionId = (index) => `${listId}-option-${index}`;

      const close = React.useCallback(() => {
        setOpen(false);
        setCursor(-1);
        setBox(null);
      }, []);

      /**
       * Undo the expansions this opening made for navigation. Only workspaces
       * this component opened are touched, and only while they still hold the
       * state it left them in, so a collapse the human made meanwhile stands.
       */
      const restoreExpanded = React.useCallback((keep = '') => {
        const expanded = expandedRef.current;
        expandedRef.current = new Map();
        for (const [workspaceId, wasExpanded] of expanded) {
          // `keep` is the workspace the human just clicked: its own toggle owns
          // the state, so taking it back here would move the row under the
          // pointer a second time.
          if (workspaceId === keep) continue;
          const header = document.querySelector(`[data-row-key="workspace:${cssEscape(workspaceId)}"]`);
          if (!(header instanceof HTMLElement)) continue;
          if ((header.getAttribute('aria-expanded') === 'true') === wasExpanded) continue;
          header.click();
        }
      }, []);

      /** Close with no choice: the sidebar returns to the human's own layout. */
      const dismiss = React.useCallback(() => {
        restoreExpanded();
        close();
      }, [restoreExpanded, close]);

      // A click on a workspace row needs the opposite order: that row's own
      // toggle decides its state first, and only afterwards are the workspaces
      // it did not touch given back. Restoring between mousedown and click
      // would move the row out from under the pointer, and the click would then
      // toggle it straight back — which is exactly what must not happen.
      const pendingRef = React.useRef(null);

      const dropGiveBack = () => {
        if (pendingRef.current === null) return;
        document.removeEventListener('click', pendingRef.current);
        pendingRef.current = null;
      };

      /** Return every borrowed expansion except `keep`, once the click lands. */
      const giveBackAfterClick = (keep) => {
        dropGiveBack();
        const listener = () => {
          dropGiveBack();
          restoreExpanded(keep);
        };
        pendingRef.current = listener;
        document.addEventListener('click', listener);
      };

      // A drawer closed while the list was still open must not leave the
      // workspaces it expanded behind either.
      React.useEffect(() => () => {
        dropGiveBack();
        restoreExpanded();
      }, [restoreExpanded]);

      /** Anchor the list to the trigger, flipping above when room runs out. */
      const place = React.useCallback(() => {
        const button = buttonRef.current;
        if (button === null) return;
        const rect = button.getBoundingClientRect();
        const gap = 6;
        const below = window.innerHeight - rect.bottom - gap - 8;
        const above = rect.top - gap - 8;
        const flip = below < 150 && above > below;
        const height = Math.max(96, Math.min(260, flip ? above : below));
        setBox({
          left: Math.round(rect.left),
          width: Math.max(180, Math.round(rect.width)),
          top: Math.round(flip ? rect.bottom - height - gap : rect.bottom + gap),
          maxHeight: Math.round(height),
        });
      }, []);

      const toggle = () => {
        if (open) {
          dismiss();
          return;
        }
        dropGiveBack();
        expandedRef.current = new Map();
        place();
        setCursor(selectedIndex);
        setOpen(true);
      };

      // The list is anchored to the button, so a scroll anywhere else (or a
      // resize) closes it instead of leaving it stranded over the page.
      React.useEffect(() => {
        if (!open) return undefined;
        const onScroll = (event) => {
          if (listRef.current !== null && event.target instanceof Node && listRef.current.contains(event.target)) return;
          dismiss();
        };
        const onResize = () => dismiss();
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onResize);
        return () => {
          window.removeEventListener('scroll', onScroll, true);
          window.removeEventListener('resize', onResize);
        };
      }, [open, dismiss]);

      React.useEffect(() => {
        if (!open) return undefined;
        const onPointer = (event) => {
          const target = event.target;
          if (!(target instanceof Node)) return;
          if (buttonRef.current?.contains(target) === true) return;
          if (listRef.current?.contains(target) === true) return;
          const row = target instanceof Element ? target.closest('[data-row-key]') : null;
          const key = row === null ? '' : String(row.getAttribute('data-row-key'));
          // A row in the workspace list is the human taking the sidebar back:
          // their click owns the state it lands on. A workspace row toggles
          // itself, so only the other borrowed expansions are returned, and
          // only after the click has been handled.
          if (key.startsWith('workspace:')) {
            giveBackAfterClick(key.slice('workspace:'.length));
            close();
            return;
          }
          // Every other row — a conversation, or the "show the rest" control —
          // is used where it stands: collapsing around the row under the
          // pointer would swallow the click or move another row beneath it.
          if (key.length > 0) {
            dropGiveBack();
            expandedRef.current = new Map();
            close();
            return;
          }
          dismiss();
        };
        document.addEventListener('mousedown', onPointer, true);
        return () => document.removeEventListener('mousedown', onPointer, true);
      }, [open, dismiss]);

      // The workspace list is the map. Moving through the options outlines the
      // conversation there: its row when visible (blue), the "expand the rest"
      // row when it sits behind that (green, because it is a control rather
      // than the conversation), and — for a collapsed workspace — the row
      // appears only after the workspace is opened.
      React.useEffect(() => {
        if (active === null) return undefined;
        const workspaceId = typeof active.workspaceId === 'string' ? active.workspaceId : '';
        const rowOf = () => document.querySelector(`[data-row-key="session:${cssEscape(active.id)}"]`);
        const overflowOf = () => (workspaceId.length === 0
          ? null
          : document.querySelector(`[data-row-key="overflow:${cssEscape(workspaceId)}"]`));
        let marked = null;
        let cancelled = false;
        let timer = 0;
        const clear = () => {
          if (marked !== null) {
            marked.classList.remove('ove-sidebar-focus');
            marked.classList.remove('ove-sidebar-focus-overflow');
          }
          marked = null;
        };
        const mark = (node, tone) => {
          if (!(node instanceof HTMLElement)) return false;
          clear();
          node.classList.add('ove-sidebar-focus');
          if (tone === 'overflow') node.classList.add('ove-sidebar-focus-overflow');
          marked = node;
          return true;
        };
        // Prefer the conversation's own row; behind the overflow row, point at
        // the control that would reveal it.
        const settle = () => {
          const row = rowOf();
          if (row instanceof HTMLElement && rowIsVisible(row)) return mark(row);
          const overflow = overflowOf();
          if (overflow instanceof HTMLElement && rowIsVisible(overflow)) return mark(overflow, 'overflow');
          return false;
        };
        if (!settle() && workspaceId.length > 0) {
          const header = document.querySelector(`[data-row-key="workspace:${cssEscape(workspaceId)}"]`);
          const collapsed = header instanceof HTMLElement
            && header.getAttribute('aria-expanded') === 'false'
            && rowIsVisible(header);
          if (collapsed && !expandedRef.current.has(workspaceId)) {
            expandedRef.current.set(workspaceId, false);
            header.click();
            let tries = 0;
            timer = window.setInterval(() => {
              tries += 1;
              if (cancelled) {
                window.clearInterval(timer);
                return;
              }
              if (settle() || tries > 15) window.clearInterval(timer);
            }, 50);
          }
        }
        return () => {
          cancelled = true;
          window.clearInterval(timer);
          clear();
        };
      }, [active]);

      React.useEffect(() => {
        if (!open || cursor < 0) return undefined;
        const node = listRef.current === null ? null : listRef.current.querySelector(`[data-index="${cursor}"]`);
        node?.scrollIntoView?.({ block: 'nearest' });
        return undefined;
      }, [open, cursor]);

      const pick = (option) => {
        close();
        // A choice keeps the sidebar as it is: the conversation that was just
        // picked should stay visible. This component no longer owns those
        // expansions, so a later close must not take them back.
        dropGiveBack();
        expandedRef.current = new Map();
        if (option.id !== value) onChange(option.id);
      };

      const move = (step) => {
        if (options.length === 0) return;
        const start = cursor < 0 ? (step > 0 ? -1 : 0) : cursor;
        setCursor(Math.max(0, Math.min(options.length - 1, start + step)));
      };

      const onKeyDown = (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (!open) {
            place();
            setCursor(selectedIndex);
            setOpen(true);
            return;
          }
          move(event.key === 'ArrowDown' ? 1 : -1);
          return;
        }
        if (!open) return;
        if (event.key === 'Home') {
          event.preventDefault();
          setCursor(0);
          return;
        }
        if (event.key === 'End') {
          event.preventDefault();
          setCursor(options.length - 1);
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          const option = options[cursor];
          if (option !== undefined) pick(option);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          dismiss();
          return;
        }
        if (event.key === 'Tab') dismiss();
      };

      return h('div', { className: 'ove-combo' },
        h('button', {
          ref: buttonRef,
          type: 'button',
          className: 'ove-select ove-combo-btn',
          role: 'combobox',
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          'aria-controls': open ? listId : undefined,
          'aria-activedescendant': open && cursor >= 0 ? optionId(cursor) : undefined,
          'data-empty': selected === null,
          title: selected === null ? tr('auto.pickSession') : sessionPathText(selected),
          onClick: toggle,
          onKeyDown,
        },
        h('span', { className: 'ove-combo-value' }, selected === null
          ? tr('auto.pickSession')
          : sessionNodes(selected, tr, duplicates.has(selected.id))),
        h('span', { className: 'ove-combo-caret', 'aria-hidden': 'true' }, '▾')),
        open && box !== null
          ? overlayPortal(h('div', {
            ref: listRef,
            id: listId,
            className: 'ove-combo-list',
            role: 'listbox',
            'aria-label': tr('auto.session'),
            style: {
              left: `${box.left}px`,
              top: `${box.top}px`,
              width: `${box.width}px`,
              maxHeight: `${box.maxHeight}px`,
            },
          },
          options.length === 0
            ? h('p', { className: 'ove-combo-empty' }, tr('auto.bindEmpty'))
            : options.map((option, index) => {
              // Rows sharing a name always carry their short id; the highlighted
              // row carries it too, so whatever the pointer or the caret is on
              // names exactly one conversation.
              const showId = duplicates.has(option.id) || index === cursor;
              return h('div', {
                key: option.id,
                id: optionId(index),
                'data-index': index,
                className: 'ove-combo-option',
                role: 'option',
                'aria-selected': option.id === value,
                'data-active': index === cursor,
                title: sessionPathText(option),
                onMouseEnter: () => setCursor(index),
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => pick(option),
              }, sessionNodes(option, tr, showId));
            })))
          : null);
    }

    /**
     * Automation task management beside the stock Automation tasks page:
     * the same list, tabs and search, plus in-place creation, bulk deletion,
     * multi-conversation binding and the auto-clean flag.
     * @param props - standard panel props and the translator.
     * @returns the automation enhancement page.
     */
    function AutomationPage({ useSessions, useWorkspaces, t, uiWorkspace }) {
      const tr = typeof t === 'function' ? t : (key) => key;
      const sessions = useSessions((snapshot) => snapshot);
      const workspaces = useWorkspaces((snapshot) => snapshot);

      const [rows, setRows] = React.useState([]);
      const [autoClean, setAutoClean] = React.useState({});
      const [recordCounts, setRecordCounts] = React.useState({});
      const [loading, setLoading] = React.useState(true);
      const [loadError, setLoadError] = React.useState('');
      const [tab, setTab] = React.useState('active');
      const [query, setQuery] = React.useState('');
      const [selected, setSelected] = React.useState(() => new Set());
      const [busy, setBusy] = React.useState('');
      const [notice, setNotice] = React.useState(null);
      const [actionError, setActionError] = React.useState('');
      const [draft, setDraft] = React.useState(null);
      const [draftError, setDraftError] = React.useState('');
      const [confirm, setConfirm] = React.useState(null);
      const [intervalRun, setIntervalRun] = React.useState(null);
      const [conflict, setConflict] = React.useState(null);
      // Whether the open draft holds an edit the human made. Only an untouched
      // draft may adopt a newer revision from the polling list.
      const [draftDirty, setDraftDirty] = React.useState(false);
      const [bindTasks, setBindTasks] = React.useState([]);
      const [bindPicks, setBindPicks] = React.useState(() => new Set());
      const [cleanPending, setCleanPending] = React.useState(false);
      const [detailTab, setDetailTab] = React.useState('edit');
      const [records, setRecords] = React.useState([]);
      const [createMenu, setCreateMenu] = React.useState(false);
      const createTriggerRef = React.useRef(null);
      const createMenuRef = React.useRef(null);
      const createMenuId = React.useId();
      const [now, setNow] = React.useState(() => Date.now());

      const announce = (text, tone = 'success') => setNotice(text.length > 0 ? { text, tone } : null);

      const load = React.useCallback(async (signal) => {
        const result = await automationCall('catalog');
        if (signal?.aborted) return undefined;
        if (!result.ok) {
          setLoadError(result.error);
          setLoading(false);
          return undefined;
        }
        setRows(Array.isArray(result.value?.tasks) ? result.value.tasks : []);
        setAutoClean(result.value?.autoClean ?? {});
        setRecordCounts(result.value?.records ?? {});
        setLoadError('');
        setLoading(false);
        return result.value;
      }, []);

      React.useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        void load(controller.signal);
        const timer = setInterval(() => { void load(controller.signal); }, 20000);
        return () => { controller.abort(); clearInterval(timer); };
      }, [load]);

      // One clock tick per second keeps "in 42 s" counting down.
      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, []);

      // The create dropdown closes on any click outside its group.
      React.useEffect(() => {
        if (!createMenu) return undefined;
        const onDown = (event) => {
          const target = event.target;
          if (target instanceof Element && target.closest('.ove-head-actions') !== null) return;
          setCreateMenu(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [createMenu]);

      // Opening "新建方式" moves focus to its first row; the menu itself handles
      // Escape, arrows, Home/End and Tab, so a keyboard user never has to click
      // empty space to close it.
      React.useEffect(() => {
        if (!createMenu) return undefined;
        const frame = requestAnimationFrame(() => {
          const first = createMenuRef.current?.querySelector('[role="menuitem"]');
          if (first instanceof HTMLElement) first.focus();
        });
        return () => cancelAnimationFrame(frame);
      }, [createMenu]);

      // A saved/deleted/delivered toast is a receipt, not a banner: clear it
      // by itself so it never piles up on top of the next action.
      React.useEffect(() => {
        if (notice === null && actionError.length === 0) return undefined;
        const timer = setTimeout(() => {
          setNotice(null);
          setActionError('');
        }, 4000);
        return () => clearTimeout(timer);
      }, [notice, actionError]);

      const sessionTitle = (id) => {
        if (typeof id !== 'string' || id.length === 0) return '';
        return sessions?.byId?.[id]?.displayTitle || id;
      };

      const targetLabel = (target) => {
        if (target?.kind === 'session') return `${tr('auto.target.session')} · ${sessionTitle(target.sessionId)}`;
        return tr(target?.kind === 'new' ? 'auto.target.new' : 'auto.target.newOnce');
      };

      const filtered = rows.filter((task) => {
        if (tab === 'active' && task.status !== 'active') return false;
        if (tab === 'paused' && task.status !== 'paused') return false;
        if (tab === 'ended' && task.status !== 'ended') return false;
        const needle = query.trim().toLowerCase();
        if (needle.length === 0) return true;
        const target = task.target?.kind === 'session' ? sessionTitle(task.target.sessionId) : '';
        return `${task.title} ${task.prompt} ${target}`.toLowerCase().includes(needle);
      });

      const toggleSelect = (id) => {
        setSelected((current) => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      };

      const openNew = () => {
        setDraft(draftOf(null));
        setDetailTab('edit');
        setRecords([]);
        setDraftError('');
        setNotice(null);
        setActionError('');
        setConflict(null);
        setDraftDirty(false);
      };

      /** The stock page's "create in a session": a new chat seeded with a create request. */
      const startInSession = () => {
        try {
          uiWorkspace?.startSession?.(undefined, {
            prompt: tr('auto.createPrompt'),
            whenDraftExists: 'append',
          });
        } catch (error) {
          setActionError(error instanceof Error ? error.message : String(error));
        }
      };

      const openEdit = (task) => {
        setDraft(draftOf(task, autoClean));
        setDetailTab('edit');
        setRecords([]);
        setDraftError('');
        setActionError('');
        setConflict(null);
        setDraftDirty(false);
        if (typeof task?.id === 'string' && task.id.length > 0) void loadRecords(task.id);
      };

      const closeDraft = () => {
        setDraft(null);
        setDetailTab('edit');
        setDraftError('');
        setRecords([]);
        setConflict(null);
        setDraftDirty(false);
      };

      const updateDraft = (patch) => {
        setDraftDirty(true);
        setDraft((current) => (current === null ? current : { ...current, ...patch }));
      };

      // A delivery bumps the task's revision without touching anything the
      // drawer edits, and the panel re-reads the list every 20 s. Adopting the
      // new revision while the draft is untouched keeps that from turning into a
      // bogus conflict (and the human's unsaved text into a dead end). An edit
      // made elsewhere is NOT adopted: the draft keeps its old revision so the
      // save reports the conflict instead of overwriting it.
      React.useEffect(() => {
        if (draft === null || draft.id === '' || draftDirty) return;
        const row = rows.find((task) => task.id === draft.id);
        if (row === undefined) return;
        if (typeof row.updatedAt !== 'string' || row.updatedAt === draft.updatedAt) return;
        const fresh = draftOf(row, autoClean);
        if (!sameDraftContent(draft, fresh)) return;
        // The run state travels with the adopted revision: a drawer that never
        // touched it must not carry the previous pause/resume into the save.
        setDraft((current) => (current === null || current.id !== draft.id
          ? current
          : { ...current, updatedAt: row.updatedAt, active: fresh.active }));
      }, [rows, draft, draftDirty]);

      const saveDraft = async (options) => {
        const force = options?.force === true;
        if (draft === null || busy !== '') return;
        const timing = timingOfDraft(draft);
        const target = targetOfDraft(draft);
        if (draft.title.trim().length === 0) {
          setDraftError(tr('auto.needName'));
          return;
        }
        if (draft.prompt.trim().length === 0) {
          setDraftError(tr('auto.needContent'));
          return;
        }
        if (timing === undefined) {
          setDraftError(tr('auto.needTiming'));
          return;
        }
        if (target === undefined) {
          setDraftError(tr('auto.needSession'));
          return;
        }
        setBusy('save');
        setDraftError('');
        // Only a one-shot rule ends on its own, so only it can be cleaned up
        // after delivery; a recurring rule keeps the flag off.
        const clean = (draft.kind === 'delay' || draft.kind === 'once') && draft.autoClean === true;
        // The drawer has no run-state control: pausing and resuming are their
        // own row actions (`toggleActive`). Sending `active` from here could
        // only ever repeat a status the human did not choose in this form, so a
        // pause made in another window is never flipped back by a later save —
        // not even by the "overwrite" answer to the conflict dialog.
        const request = {
          title: draft.title.trim(),
          prompt: draft.prompt,
          timing,
          target,
          autoClean: clean,
        };
        const result = draft.id === ''
          ? await automationCall('create', request)
          : await automationCall('update', {
            id: draft.id,
            ...request,
            // The Host compares this with the stored revision, so a save from a
            // drawer someone else has since updated is reported instead of
            // silently winning. A confirmed overwrite drops it.
            ...(force || typeof draft.updatedAt !== 'string' ? {} : { expectedUpdatedAt: draft.updatedAt }),
          });
        setBusy('');
        if (!result.ok) {
          // The task changed under this drawer. Keep the human's text and let
          // them choose between keeping the other change and overwriting it.
          if (!force && draft.id !== '' && result.code === 'schedule_conflict') {
            setConflict({ title: draft.title });
            return;
          }
          setDraftError(result.error);
          return;
        }
        const savedId = draft.id === '' ? result.value?.id : draft.id;
        if (typeof savedId === 'string' && savedId.length > 0) {
          setAutoClean((current) => {
            const next = { ...current };
            if (clean) next[savedId] = true;
            else delete next[savedId];
            return next;
          });
        }
        announce(tr('auto.saved'), 'success');
        setDraft(null);
        setRecords([]);
        await load();
      };

      const toggleActive = async (task) => {
        const next = task.status === 'active' ? false : true;
        setBusy('active');
        const result = await automationCall('update', { id: task.id, active: next });
        setBusy('');
        if (!result.ok) {
          setActionError(result.error);
          return;
        }
        announce(tr(next ? 'auto.resumeOne' : 'auto.pauseOne').replace('{name}', task.title), next ? 'success' : 'warn');
        await load();
        // Keep the open draft in step with the row it belongs to, so a save after
        // pausing does not report a stale revision as a conflict.
        if (draft !== null && draft.id === task.id) {
          updateDraft({
            active: next,
            updatedAt: typeof result.value?.updatedAt === 'string' ? result.value.updatedAt : draft.updatedAt,
          });
        }
      };

      /**
       * Whether the Host still holds this task inside its delivery interval.
       *
       * The catalog only carries the instant the interval ends while it runs, and
       * the panel's one-second clock re-evaluates it, so the "(interval)" state
       * clears itself without another round trip.
       * @param task - one automation row.
       * @returns true while an immediate delivery would bypass the interval.
       */
      const withinInterval = (task) => {
        const floor = task?.deliveryFloorEndsAt;
        return typeof floor === 'string' && Date.parse(floor) > now;
      };

      const runNow = async (task, options) => {
        if (busy !== '') return;
        const confirmed = options?.confirmed === true;
        setBusy('run');
        setActionError('');
        const result = await automationCall('run', confirmed ? { id: task.id, withinInterval: true } : { id: task.id });
        setBusy('');
        if (!result.ok) {
          // The Host's own delivery is the one that records a run. A task still
          // inside its interval is refused there; the fallback delivers anyway but
          // cannot report a run record, so the human has to accept that. A task
          // that is executing right now is a different answer: delivering again
          // would send the same reminder twice, so there is nothing to confirm.
          if (!confirmed && result.code === 'schedule-delivery-interval') {
            setIntervalRun(task);
            return;
          }
          setActionError(result.error);
          return;
        }
        setIntervalRun(null);
        // A `new_once` task comes back bound to the conversation this delivery
        // created, so the receipt says so instead of a bare "delivered".
        const adopted = task.target?.kind === 'new_once' && result.value?.target?.kind === 'session';
        announce(tr(confirmed ? 'auto.ranInterval' : adopted ? 'auto.ranAdopted' : 'auto.ran'), 'info');
        await load();
        if (draft !== null && draft.id === task.id) void loadRecords(task.id);
      };

      /**
       * Start a delivery, asking first when it has to bypass the Host's interval.
       * @param task - one automation row.
       */
      const requestRun = (task) => {
        if (busy !== '') return;
        // The catalog marks a task whose delivery is queued or running. Nothing
        // to confirm here: a second delivery would duplicate the reminder.
        if (task?.executionActive === true) {
          setActionError(tr('auto.deliveringNote'));
          return;
        }
        if (withinInterval(task)) {
          setIntervalRun(task);
          return;
        }
        void runNow(task);
      };

      const removeTasks = async (ids) => {
        if (ids.length === 0 || busy !== '') return;
        setBusy('delete');
        setActionError('');
        const result = await automationCall('delete', { ids });
        setBusy('');
        setConfirm(null);
        if (!result.ok) {
          setActionError(result.error);
          return;
        }
        const deleted = result.value?.deleted?.length ?? 0;
        const failed = result.value?.failed?.length ?? 0;
        announce(failed === 0
          ? tr('auto.deleted').replace('{count}', String(deleted))
          : tr('auto.deleteFailed').replace('{count}', String(failed)), 'danger');
        setSelected(new Set());
        if (draft !== null && ids.includes(draft.id)) setDraft(null);
        await load();
      };

      const setSelectedActive = async (resume) => {
        if (busy !== '' || selectedRows.length === 0) return;
        const targets = selectedRows.filter((task) => (resume
          ? task.status === 'paused'
          : task.status === 'active'));
        if (targets.length === 0) {
          setActionError(tr(resume ? 'auto.resumeNone' : 'auto.pauseNone'));
          return;
        }
        setBusy(resume ? 'resume' : 'pause');
        setActionError('');
        let failed = 0;
        for (const task of targets) {
          const result = await automationCall('update', { id: task.id, active: resume });
          if (!result.ok) {
            failed += 1;
            setActionError(result.error);
          }
        }
        setBusy('');
        if (failed === 0) {
          announce(
            tr(resume ? 'auto.resumedMany' : 'auto.pausedMany').replace('{count}', String(targets.length)),
            resume ? 'success' : 'warn',
          );
          setSelected(new Set());
        }
        await load();
      };

      const pauseSelected = () => setSelectedActive(false);
      const resumeSelected = () => setSelectedActive(true);

      const loadRecords = async (id) => {
        if (typeof id !== 'string' || id.length === 0) return;
        const result = await automationCall('history', { id });
        if (!result.ok) return;
        setRecords(Array.isArray(result.value?.records) ? result.value.records : []);
      };

      const openBind = (tasks) => {
        const list = Array.isArray(tasks) ? tasks.filter((task) => task !== null && task !== undefined) : [];
        setBindTasks(list);
        setBindPicks(new Set());
        setActionError('');
        setNotice(null);
      };

      const closeBind = () => {
        setBindTasks([]);
        setBindPicks(new Set());
      };

      const confirmBind = async () => {
        if (bindTasks.length === 0 || bindPicks.size === 0 || busy !== '') return;
        setBusy('bind');
        setActionError('');
        const result = await automationCall('bind', {
          ids: bindTasks.map((task) => task.id),
          sessionIds: [...bindPicks],
        });
        setBusy('');
        if (!result.ok) {
          setActionError(result.error);
          return;
        }
        const created = result.value?.created?.length ?? 0;
        const skipped = result.value?.skipped?.length ?? 0;
        const failed = result.value?.failed ?? [];
        closeBind();
        // A finished binding ends the batch: drop the selection it was made on.
        setSelected(new Set());
        const done = tr('auto.bindDone').replace('{count}', String(created));
        const skippedText = skipped > 0 ? `，${tr('auto.bindSkipped').replace('{count}', String(skipped))}` : '';
        if (failed.length === 0) {
          announce(`${done}${skippedText}`, 'success');
        } else {
          setActionError(tr('auto.bindFailed').replace('{names}', failed
            .map((entry) => {
              const known = sessionInfo(entry.sessionId);
              const name = known === null ? sessionTitle(entry.sessionId) : sessionPathText(known);
              return entry.message ? `${name}（${entry.message}）` : name;
            })
            .join('、')));
        }
        await load();
      };

      const sessionOptions = React.useMemo(() => {
        const byId = sessions?.byId ?? {};
        const archived = new Set(Array.isArray(workspaces?.archivedSessionIds) ? workspaces.archivedSessionIds : []);
        const items = Array.isArray(workspaces?.items) ? workspaces.items : [];
        const recordOf = (id) => {
          const record = byId[id];
          return record !== null && typeof record === 'object' ? record : {};
        };
        const titleOf = (id) => String(recordOf(id).displayTitle || recordOf(id).title || '').trim();
        const stampOf = (id) => {
          const record = recordOf(id);
          return Date.parse(record.updatedAt ?? record.createdAt ?? '') || 0;
        };
        // The workspace title tells two conversations with one name apart, and
        // its id is how the workspace row is reached in the sidebar, so both
        // travel with every candidate.
        const ownerOf = (id) => items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(id));
        const workspaceTitleOf = (owner) => (owner === undefined
          ? ''
          : String(owner.title || owner.path || '').trim());
        // Every sidebar conversation, tagged with its workspace. A conversation
        // still carrying its workspace's name is an untitled placeholder.
        const candidates = [];
        const seen = new Set();
        for (const workspace of items) {
          const workspaceTitle = String(workspace?.title || '').trim();
          for (const id of Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []) {
            if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
            seen.add(id);
            if (archived.has(id)) continue;
            const title = titleOf(id);
            if (title.length === 0) continue;
            if (workspaceTitle.length > 0 && title === workspaceTitle) continue;
            candidates.push({ id, title, workspace: workspaceTitle, workspaceId: String(workspace.workspaceId ?? ''), stamp: stampOf(id) });
          }
        }
        for (const id of Object.keys(byId)) {
          if (seen.has(id) || archived.has(id)) continue;
          const title = titleOf(id);
          if (title.length === 0) continue;
          const owner = ownerOf(id);
          candidates.push({
            id,
            title,
            workspace: workspaceTitleOf(owner),
            workspaceId: owner === undefined ? '' : String(owner.workspaceId ?? ''),
            stamp: stampOf(id),
          });
        }
        // Duplicate names are kept: the workspace half tells them apart, and
        // hiding one would hide the conversation the human wants to pick.
        return candidates
          .map((session) => ({ ...session, archived: false, label: session.title }))
          .sort((a, b) => a.label.localeCompare(b.label)
            || a.workspace.localeCompare(b.workspace)
            || b.stamp - a.stamp);
      }, [sessions, workspaces]);

      /** Sessions a task may point at, plus its own archived target when it has one. */
      const targetSessions = React.useMemo(() => {
        const current = draft?.sessionId;
        if (typeof current !== 'string' || current.length === 0) return sessionOptions;
        if (sessionOptions.some((session) => session.id === current)) return sessionOptions;
        const record = sessions?.byId?.[current];
        const title = String(record?.displayTitle || current);
        const items = Array.isArray(workspaces?.items) ? workspaces.items : [];
        const owner = items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(current));
        const workspace = owner === undefined ? '' : String(owner.title || owner.path || '').trim();
        const workspaceId = owner === undefined ? '' : String(owner.workspaceId ?? '');
        return [{ id: current, title, workspace, workspaceId, label: title, archived: true, stamp: 0 }, ...sessionOptions];
      }, [sessionOptions, draft?.sessionId, sessions, workspaces]);

      /** One conversation by id, qualified with its workspace when known. */
      const sessionInfo = (id) => {
        if (typeof id !== 'string' || id.length === 0) return null;
        const known = sessionOptions.find((session) => session.id === id)
          ?? targetSessions.find((session) => session.id === id);
        if (known !== undefined) return known;
        const items = Array.isArray(workspaces?.items) ? workspaces.items : [];
        const owner = items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(id));
        return {
          id,
          label: sessionTitle(id),
          workspace: owner === undefined ? '' : String(owner.title || owner.path || '').trim(),
          workspaceId: owner === undefined ? '' : String(owner.workspaceId ?? ''),
          archived: false,
        };
      };

      /** Conversations that do not already take part in one of the tasks being bound. */
      const bindCandidates = React.useMemo(() => {
        const bound = new Set();
        for (const task of bindTasks) {
          if (task?.target?.kind === 'session') bound.add(task.target.sessionId);
          for (const id of Array.isArray(task?.involvedSessionIds) ? task.involvedSessionIds : []) bound.add(id);
          // Conversations an earlier binding already covers, identified by the
          // copies it created rather than by a title match.
          for (const id of Array.isArray(task?.copySessionIds) ? task.copySessionIds : []) bound.add(id);
        }
        return sessionOptions.filter((session) => !bound.has(session.id));
      }, [sessionOptions, bindTasks]);

      /** Rows in the bind picker that need their short id to stay distinct. */
      const bindDuplicates = React.useMemo(() => duplicateIdsOf(bindCandidates), [bindCandidates]);

      const workspaceOptions = React.useMemo(() => {
        const items = Array.isArray(workspaces?.items) ? workspaces.items : [];
        return items
          .map((item) => ({
            id: item.id,
            title: String(item.title || item.path || item.directory || item.id),
            path: typeof item.path === 'string'
              ? item.path
              : (typeof item.directory === 'string' ? item.directory : ''),
          }))
          .filter((item) => item.path.length > 0);
      }, [workspaces]);

      /**
       * Workspace and conversation a task delivers into, for the row title.
       * @param task - one automation row.
       * @returns the display names, either possibly empty.
       */
      const taskContext = (task) => {
        const sessionId = task?.target?.kind === 'session' ? task.target.sessionId : '';
        const session = sessionId.length > 0 ? sessionTitle(sessionId) : '';
        // A session target inherits the workspace that owns the conversation.
        let workspace = '';
        if (sessionId.length > 0) {
          const items = Array.isArray(workspaces?.items) ? workspaces.items : [];
          const owner = items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId));
          if (owner !== undefined) workspace = String(owner.title || owner.path || '');
        }
        const cwd = typeof task?.target?.cwd === 'string' ? task.target.cwd : '';
        if (workspace.length === 0 && cwd.length > 0) {
          const known = workspaceOptions.find((item) => item.path.toLowerCase() === cwd.toLowerCase());
          workspace = known === undefined
            ? (cwd.split(/[\\/]/).filter((part) => part.length > 0).pop() ?? '')
            : known.title;
        }
        return {
          workspace,
          session: session === sessionId ? '' : session,
        };
      };

      const portal = (node) => (node !== null && node !== undefined
        && typeof ReactDOM?.createPortal === 'function'
        && typeof document !== 'undefined')
        ? ReactDOM.createPortal(node, document.body)
        : node;

      const selectedRows = rows.filter((task) => selected.has(task.id));
      const panelTask = draft !== null && draft.id !== ''
        ? rows.find((task) => task.id === draft.id) ?? null
        : null;
      const oneShot = draft !== null && (draft.kind === 'delay' || draft.kind === 'once');

      const tabs = [
        ['active', tr('auto.tab.active'), 'ove-tone-active'],
        ['paused', tr('auto.tab.paused'), 'ove-tone-paused'],
        ['ended', tr('auto.tab.ended'), 'ove-tone-ended'],
        ['all', tr('auto.tab.all'), 'ove-tone-all'],
      ];

      const tabCounts = {
        active: rows.filter((task) => task.status === 'active').length,
        paused: rows.filter((task) => task.status === 'paused').length,
        ended: rows.filter((task) => task.status === 'ended').length,
        all: rows.length,
      };

      const statusText = (status) => {
        const key = `auto.status.${status ?? 'unknown'}`;
        const value = tr(key);
        return value === key ? tr('auto.status.unknown') : value;
      };

      const editor = draft === null ? null : h('aside', { className: 'ove-detail' },
        h('div', { className: 'ove-detail-head' },
          h('span', { className: 'ove-label' }, draft.id === '' ? tr('auto.createTitle') : tr('auto.editTitle')),
          h('div', { className: 'ove-detail-actions' },
            h('button', {
              type: 'button',
              className: 'ove-icon-btn',
              'aria-label': tr('cancel'),
              onClick: closeDraft,
            }, '×'))),
        draft.id === ''
          ? null
          : h('div', { className: 'ove-detail-tabs', role: 'tablist' },
            [['edit', tr('auto.tabEdit'), 0], ['records', tr('auto.tabRecords'), records.length]].map(([value, label, count]) => h('button', {
              key: value,
              type: 'button',
              role: 'tab',
              className: 'ove-detail-tab',
              'aria-selected': detailTab === value,
              onClick: () => {
                setDetailTab(value);
                // The list may have grown since the drawer opened, so refresh
                // the receipts whenever the history tab is entered.
                if (value === 'records' && draft.id !== '') void loadRecords(draft.id);
              },
            }, label, count > 0 ? `（${count}）` : ''))),
        detailTab === 'records' && draft.id !== ''
          ? h('div', { className: 'ove-detail-body' },
            h('div', { className: 'ove-field ove-records' },
              records.length === 0
                ? h('p', { className: 'ove-muted ove-records-empty' }, tr('auto.recordsEmpty'))
                : h('ul', { className: 'ove-record-list ove-record-list-tall' },
                  records.map((record) => h('li', { key: record.messageId, className: 'ove-record' },
                    h('div', { className: 'ove-record-head' },
                      h('span', { className: 'ove-record-time' }, formatInstant(record.deliveredAt)),
                      h('span', { className: 'ove-record-target' },
                        record.targetSessionId
                          ? sessionNodes(sessionInfo(record.targetSessionId)
                            ?? { workspace: '', label: sessionTitle(record.targetSessionId), archived: false }, tr)
                          : '')),
                    h('p', { className: 'ove-record-prompt' },
                      typeof record.prompt === 'string' && record.prompt.length > 0
                        ? record.prompt
                        : (draft.prompt ?? '')))))))
          : h('div', { className: 'ove-detail-body' },
          h('label', { className: 'ove-field' },
            h('span', { className: 'ove-label' }, tr('auto.name')),
            h('input', {
              className: 'ove-input',
              value: draft.title,
              onChange: (event) => updateDraft({ title: event.target.value }),
            })),
          h('label', { className: 'ove-field' },
            h('span', { className: 'ove-label' }, tr('auto.content')),
            h('textarea', {
              className: 'ove-textarea',
              value: draft.prompt,
              onChange: (event) => updateDraft({ prompt: event.target.value }),
            })),
          h('label', { className: 'ove-field' },
            h('span', { className: 'ove-label' }, tr('auto.target')),
            h('select', {
              className: 'ove-select',
              value: draft.targetKind,
              onChange: (event) => updateDraft({ targetKind: event.target.value }),
            },
            h('option', { value: 'new_once' }, tr('auto.target.newOnce')),
            h('option', { value: 'new' }, tr('auto.target.new')),
            h('option', { value: 'session' }, tr('auto.target.session')))),
          draft.targetKind === 'session'
            ? h('label', { className: 'ove-field' },
              h('span', { className: 'ove-label' }, tr('auto.session')),
              h(SessionPicker, {
                options: targetSessions,
                value: draft.sessionId,
                tr,
                onChange: (sessionId) => updateDraft({ sessionId }),
              }))
            : h('label', { className: 'ove-field' },
              h('span', { className: 'ove-label' }, tr('auto.workspace')),
              h('select', {
                className: 'ove-select',
                value: draft.cwd,
                onChange: (event) => updateDraft({ cwd: event.target.value }),
              },
              h('option', { value: '' }, tr('auto.workspaceDefault')),
              workspaceOptions.map((workspace) => h('option', {
                key: workspace.id,
                value: workspace.path,
                title: workspace.path,
              }, workspace.title)))),
          h('label', { className: 'ove-field' },
            h('span', { className: 'ove-label' }, tr('auto.repeat')),
            h('select', {
              className: 'ove-select',
              value: draft.kind,
              onChange: (event) => updateDraft({ kind: event.target.value }),
            },
            h('option', { value: 'weekly' }, tr('auto.repeat.weekly')),
            h('option', { value: 'weekdays' }, tr('auto.repeat.weekdays')),
            h('option', { value: 'daily' }, tr('auto.repeat.daily')),
            h('option', { value: 'hourly' }, tr('auto.repeat.hourly')),
            h('option', { value: 'minutely' }, tr('auto.repeat.minutely')),
            h('option', { value: 'monthly' }, tr('auto.repeat.monthly')),
            h('option', { value: 'delay' }, tr('auto.repeat.delay')),
            h('option', { value: 'once' }, tr('auto.repeat.once')),
            h('option', { value: 'rrule' }, tr('auto.repeat.rrule')),
            h('option', { value: 'cron' }, tr('auto.repeat.cron')))),
          draft.kind === 'delay'
            ? h('div', { className: 'ove-inline' },
              h('label', { className: 'ove-field' },
                h('span', { className: 'ove-label' }, tr(draft.delayUnit === 'sec' ? 'auto.delaySeconds' : 'auto.delayMinutes')),
                h('input', {
                  type: 'number',
                  min: 1,
                  className: 'ove-input',
                  value: draft.interval,
                  onChange: (event) => updateDraft({ interval: event.target.value }),
                })),
              h('label', { className: 'ove-field ove-unit' },
                h('span', { className: 'ove-label' }, tr('auto.unit')),
                h('select', {
                  className: 'ove-select',
                  value: draft.delayUnit,
                  onChange: (event) => updateDraft({ delayUnit: event.target.value }),
                },
                h('option', { value: 'min' }, tr('auto.unitMinute')),
                h('option', { value: 'sec' }, tr('auto.unitSecond')))))
            : draft.kind === 'minutely' || draft.kind === 'hourly'
              ? h('label', { className: 'ove-field' },
                h('span', { className: 'ove-label' }, tr(draft.kind === 'hourly' ? 'auto.intervalHours' : 'auto.intervalMinutes')),
                h('input', {
                  type: 'number',
                  min: 1,
                  className: 'ove-input',
                  value: draft.interval,
                  onChange: (event) => updateDraft({ interval: event.target.value }),
                }))
              : null,
          draft.kind === 'once' || draft.kind === 'daily' || draft.kind === 'weekdays' || draft.kind === 'monthly'
            ? h('div', { className: 'ove-inline' },
              draft.kind === 'once'
                ? h('label', { className: 'ove-field' },
                  h('span', { className: 'ove-label' }, tr('auto.date')),
                  h('input', {
                    type: 'date',
                    className: 'ove-input',
                    value: draft.date,
                    onChange: (event) => updateDraft({ date: event.target.value }),
                  }))
                : null,
              h('label', { className: 'ove-field' },
                h('span', { className: 'ove-label' }, tr('auto.time')),
                h('input', {
                  type: 'time',
                  step: 1,
                  className: 'ove-input',
                  value: draft.time,
                  onChange: (event) => updateDraft({ time: event.target.value }),
                })))
            : null,
          draft.kind === 'weekly'
            ? h('div', { className: 'ove-inline' },
              h('div', { className: 'ove-field' },
                h('span', { className: 'ove-label' }, tr('auto.weekday')),
                h('div', { className: 'ove-weekdays', role: 'group', 'aria-label': tr('auto.weekday') },
                  WEEKDAY_KEYS.map((key, index) => h('button', {
                    key,
                    type: 'button',
                    className: 'ove-weekday',
                    'aria-pressed': draft.weekdays.includes(index),
                    'data-on': draft.weekdays.includes(index),
                    onClick: () => updateDraft({
                      // A weekly rule can name several days; toggling one must not
                      // drop the others.
                      weekdays: draft.weekdays.includes(index)
                        ? draft.weekdays.filter(day => day !== index)
                        : [...draft.weekdays, index].sort((a, b) => a - b),
                    }),
                  }, tr(`auto.weekday.${key}`)))),
                draft.weekdays.length === 0
                  // The save falls back to Monday; saying so keeps the result
                  // from looking like the removed day came back.
                  ? h('p', { className: 'ove-hint' }, tr('auto.weekdayEmpty'))
                  : null),
              h('label', { className: 'ove-field' },
                h('span', { className: 'ove-label' }, tr('auto.time')),
                h('input', {
                  type: 'time',
                  step: 1,
                  className: 'ove-input',
                  value: draft.time,
                  onChange: (event) => updateDraft({ time: event.target.value }),
                })))
            : null,
          draft.kind === 'monthly'
            ? h('label', { className: 'ove-field' },
              h('span', { className: 'ove-label' }, tr('auto.monthDay')),
              h('input', {
                type: 'number',
                min: 1,
                max: 31,
                className: 'ove-input',
                value: draft.monthDay,
                onChange: (event) => updateDraft({ monthDay: event.target.value }),
              }))
            : null,
          draft.kind === 'rrule'
            ? h('div', { className: 'ove-field' },
              h('label', { className: 'ove-label' }, tr('auto.rule')),
              h('textarea', {
                className: 'ove-textarea ove-rule',
                value: draft.rrule,
                spellCheck: false,
                onChange: (event) => updateDraft({ rrule: event.target.value }),
              }),
              h('div', { className: 'ove-example' },
                h('div', { className: 'ove-example-label' }, tr('auto.ruleExample')),
                h('div', { className: 'ove-example-chips' },
                  RRULE_EXAMPLES.map((example) => h('button', {
                    key: example.body,
                    type: 'button',
                    className: 'ove-example-chip',
                    title: `RRULE:${example.body}`,
                    onClick: () => updateDraft({
                      rrule: `DTSTART;TZID=${timeZone()}:${draft.date.replace(/-/g, '')}T${rruleClock(draft.time)}\nRRULE:${example.body}`,
                    }),
                  }, tr(example.label))))))
            : null,
          draft.kind === 'cron'
            ? h('label', { className: 'ove-field' },
              h('span', { className: 'ove-label' }, tr('auto.cronExpr')),
              h('input', {
                className: 'ove-input ove-cron',
                value: draft.cron,
                spellCheck: false,
                placeholder: '0 9 * * 1-5',
                onChange: (event) => updateDraft({ cron: event.target.value }),
              }),
              h('span', { className: 'ove-hint' }, tr('auto.cronHint')))
            : null,
          oneShot
            ? h('div', { className: 'ove-field' },
              h('label', { className: 'ove-check-row' },
                h('input', {
                  type: 'checkbox',
                  className: 'ove-auto-check',
                  checked: draft.autoClean === true,
                  onChange: () => updateDraft({ autoClean: !draft.autoClean }),
                }),
                h('span', { className: 'ove-label' }, tr('auto.clean'))))
            : null,
          panelTask !== null
            ? h('div', { className: 'ove-detail-actions-row' },
              h('button', {
                type: 'button',
                className: `ove-btn ${withinInterval(panelTask) ? 'ove-btn-warn' : 'ove-btn-ok'}`,
                disabled: busy !== '' || panelTask.executionActive === true,
                onClick: () => requestRun(panelTask),
              }, panelTask.executionActive === true
                ? tr('auto.delivering')
                : busy === 'run'
                  ? tr('auto.running')
                  : tr(withinInterval(panelTask) ? 'auto.runInterval' : 'auto.run')),
              h('button', {
                type: 'button',
                className: 'ove-btn ove-btn-warn',
                disabled: busy !== '',
                onClick: () => void toggleActive(panelTask),
              }, panelTask.status === 'active' ? tr('auto.pauseTask') : tr('auto.resumeTask')),
              h('button', {
                type: 'button',
                className: 'ove-btn ove-btn-danger-tint',
                disabled: busy !== '',
                onClick: () => setConfirm({ ids: [panelTask.id], title: panelTask.title }),
              }, tr('auto.deleteTask')))
            : null),
        // The save control lives outside the scrolling body, so it stays visible
        // however long the form gets.
        detailTab === 'records' && draft.id !== ''
          ? null
          : h('div', { className: 'ove-detail-foot' },
            draftError.length > 0 ? h('p', { className: 'ove-error' }, draftError) : null,
            h('button', {
              type: 'button',
              className: 'ove-primary ove-detail-save',
              disabled: busy !== '',
              onClick: () => void saveDraft(),
            }, busy === 'save' ? tr('auto.saving') : tr('auto.save'))));

      return h('div', { className: 'ove-auto' },
        h('style', { key: 'styles', 'data-plugin-css': `${NS}-automation` }, CSS),
        h('div', { className: 'ove-auto-main' },
          h('div', { className: 'ove-auto-scroll' },
            h('div', { className: 'ove-auto-inner' },
              h('div', { className: 'ove-auto-heading' },
                h('h1', { className: 'ove-auto-title-text' }, tr('auto.panel')),
                h('div', {
                  className: 'ove-head-actions',
                  onBlur: (event) => {
                    const next = event.relatedTarget;
                    if (next instanceof Node && event.currentTarget.contains(next)) return;
                    setCreateMenu(false);
                  },
                },
                  h('span', { className: 'ove-split', role: 'group', 'aria-label': tr('auto.new') },
                    h('button', {
                      type: 'button',
                      className: 'ove-split-main',
                      onClick: openNew,
                    }, `+ ${tr('auto.new')}`),
                    h('button', {
                      ref: createTriggerRef,
                      type: 'button',
                      className: 'ove-split-more',
                      'aria-label': tr('auto.createMethod'),
                      'aria-haspopup': 'menu',
                      'aria-expanded': createMenu,
                      'aria-controls': createMenu ? createMenuId : undefined,
                      onClick: () => setCreateMenu((value) => !value),
                      onKeyDown: (event) => {
                        if (event.key === 'ArrowDown' && !createMenu) {
                          event.preventDefault();
                          setCreateMenu(true);
                        }
                      },
                    }, h('svg', {
                      viewBox: '0 0 16 16',
                      width: 12,
                      height: 12,
                      fill: 'none',
                      stroke: 'currentColor',
                      strokeWidth: 1.6,
                      strokeLinecap: 'round',
                      strokeLinejoin: 'round',
                      'aria-hidden': 'true',
                    }, h('path', { d: 'm3.5 6 4.5 4.5L12.5 6' })))),
                  createMenu
                    ? h('div', {
                      ref: createMenuRef,
                      id: createMenuId,
                      className: 'ove-split-menu',
                      role: 'menu',
                      onKeyDown: (event) => {
                        const items = [...(createMenuRef.current?.querySelectorAll('[role="menuitem"]') ?? [])];
                        const current = items.indexOf(document.activeElement);
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          setCreateMenu(false);
                          createTriggerRef.current?.focus();
                          return;
                        }
                        if (event.key === 'Tab') {
                          setCreateMenu(false);
                          return;
                        }
                        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                          event.preventDefault();
                          if (items.length === 0) return;
                          const step = event.key === 'ArrowDown' ? 1 : -1;
                          const next = current < 0
                            ? (step > 0 ? 0 : items.length - 1)
                            : (current + step + items.length) % items.length;
                          items[next].focus();
                          return;
                        }
                        if (event.key === 'Home' || event.key === 'End') {
                          event.preventDefault();
                          const target = event.key === 'Home' ? items[0] : items[items.length - 1];
                          target?.focus();
                        }
                      },
                    },
                      h('button', {
                        type: 'button',
                        role: 'menuitem',
                        className: 'ove-menu-row',
                        onClick: () => {
                          setCreateMenu(false);
                          startInSession();
                        },
                      }, tr('auto.createInSession')),
                      h('button', {
                        type: 'button',
                        role: 'menuitem',
                        className: 'ove-menu-row',
                        onClick: () => {
                          setCreateMenu(false);
                          openNew();
                        },
                      }, tr('auto.createManually')))
                    : null)),

              h('div', { className: 'ove-tabs', role: 'tablist' },
                tabs.map(([value, label, tone]) => h('button', {
                  key: value,
                  type: 'button',
                  role: 'tab',
                  className: 'ove-tab',
                  'data-tone': value,
                  'aria-selected': tab === value,
                  onClick: () => {
                    setTab(value);
                    // A different status filter starts a new batch, so the old
                    // selection must not follow the tasks it no longer shows.
                    setSelected(new Set());
                  },
                }, label,
                h('span', { className: `ove-tab-count ${tone}` }, String(tabCounts[value]))))),

              h('div', { className: 'ove-search-row' },
                h('span', { className: 'ove-search-icon' },
                  h('svg', {
                    viewBox: '0 0 16 16',
                    width: 16,
                    height: 16,
                    fill: 'none',
                    stroke: 'currentColor',
                    strokeWidth: 1.4,
                    strokeLinecap: 'round',
                    'aria-hidden': 'true',
                  },
                  h('circle', { cx: 7, cy: 7, r: 4.5 }),
                  h('path', { d: 'M10.5 10.5 14 14' }))),
                h('input', {
                  className: 'ove-search-input',
                  type: 'search',
                  placeholder: tr('auto.search'),
                  'aria-label': tr('auto.search'),
                  value: query,
                  onChange: (event) => setQuery(event.target.value),
                })),

              // A fixed-height strip keeps the list from jumping when the
              // selection bar or an action receipt appears and disappears.
              h('div', { className: 'ove-list-top' },
                selectedRows.length > 0
                  ? h('div', { className: 'ove-bulk' },
                    h('span', { className: 'ove-bulk-count' }, tr('auto.selected').replace('{count}', String(selectedRows.length))),
                    h('button', {
                      type: 'button',
                      className: 'ove-btn ove-btn-info',
                      onClick: () => openBind(selectedRows),
                    }, tr('auto.bind')),
                    h('button', {
                      type: 'button',
                      className: `ove-btn ${tab === 'paused' ? 'ove-btn-ok' : 'ove-btn-warn'}`,
                      disabled: busy !== '',
                      onClick: () => void (tab === 'paused' ? resumeSelected() : pauseSelected()),
                    }, tr(tab === 'paused' ? 'auto.resumeSelected' : 'auto.pauseSelected')),
                    h('button', {
                      type: 'button',
                      className: 'ove-btn ove-btn-danger-tint',
                      onClick: () => setConfirm({ ids: selectedRows.map((task) => task.id), title: '' }),
                    }, tr('auto.deleteSelected')),
                    h('button', {
                      type: 'button',
                      className: 'ove-btn',
                      onClick: () => setSelected(new Set()),
                    }, tr('auto.clearSelection')))
                  : actionError.length > 0
                    ? h('p', { className: 'ove-error', role: 'alert' }, actionError)
                    : notice !== null
                      ? h('p', { className: `ove-notice ove-notice-${notice.tone}`, role: 'status' }, notice.text)
                      : null),

              loading && rows.length === 0 ? h('p', { className: 'ove-muted' }, tr('auto.loading')) : null,
              loadError.length > 0
                ? h('p', { className: 'ove-error' }, `${tr('auto.error')}：${loadError}`)
                : null,

              !loading && loadError.length === 0 && filtered.length === 0
                ? h('div', { className: 'ove-empty' },
                  h('div', { className: 'ove-empty-art' }, h(EmptyArt, null)),
                  h('p', { className: 'ove-empty-text' }, query.trim().length > 0 ? tr('auto.noMatches') : tr('auto.empty')),
                  rows.length === 0
                    ? h('button', { type: 'button', className: 'ove-btn', onClick: openNew }, tr('auto.emptyAction'))
                    : null)
                : null,

              filtered.length > 0
                ? h('div', { className: 'ove-select-bar' },
                  h('label', { className: 'ove-select-all' },
                    h('input', {
                      type: 'checkbox',
                      className: 'ove-task-check',
                      checked: filtered.every((task) => selected.has(task.id)),
                      onChange: () => {
                        const all = filtered.every((task) => selected.has(task.id));
                        setSelected((current) => {
                          const next = new Set(current);
                          for (const task of filtered) {
                            if (all) next.delete(task.id);
                            else next.add(task.id);
                          }
                          return next;
                        });
                      },
                    }),
                    h('span', null, tr('auto.selectAll'))))
                : null,
              h('div', { className: 'ove-task-list' }, filtered.map((task) => h('div', {
                key: task.id,
                className: 'ove-task',
                'data-active': draft !== null && draft.id === task.id,
                role: 'button',
                tabIndex: 0,
                onClick: () => openEdit(task),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openEdit(task);
                  }
                },
              },
              h('input', {
                type: 'checkbox',
                className: 'ove-task-check',
                'aria-label': tr('auto.select'),
                checked: selected.has(task.id),
                onClick: (event) => event.stopPropagation(),
                onChange: () => toggleSelect(task.id),
              }),
              h('span', { className: 'ove-task-icon' }, h(ClockMark, null)),
              h('div', { className: 'ove-task-body' },
                h('div', { className: 'ove-task-title' },
                  task.title,
                  (() => {
                    const context = taskContext(task);
                    if (context.workspace.length === 0 && context.session.length === 0) return null;
                    return h('span', { className: 'ove-task-context' },
                      ' (',
                      context.workspace.length > 0
                        ? h('span', { className: 'ove-task-context-workspace' }, context.workspace)
                        : null,
                      context.workspace.length > 0 && context.session.length > 0
                        ? h('span', null, '/')
                        : null,
                      context.session.length > 0
                        ? h('span', { className: 'ove-task-context-session' }, context.session)
                        : null,
                      ')');
                  })()),
                h('div', { className: 'ove-task-meta' },
                  (() => {
                    const head = task.status === 'active' ? recurrenceOf(task, tr) : statusText(task.status);
                    const relative = task.status === 'ended' ? '' : relativeTo(task.scheduledAt, tr, now);
                    const when = task.scheduledAt
                      ? `${tr('auto.nextAt')}：${formatInstant(task.scheduledAt)}${relative.length > 0 ? `（${relative}）` : ''}`
                      : '';
                    const deliveredAt = task.lastDelivery?.deliveredAt;
                    const delivered = typeof deliveredAt === 'string' && deliveredAt.length > 0
                      ? `${tr('auto.lastDelivery')}：${formatInstant(deliveredAt)}`
                      : '';
                    const runs = recordCounts[task.id] ?? 0;
                    const runsText = runs > 0 ? `${tr('auto.records')}：${runs}` : '';
                    return [head, when, delivered, runsText].filter((part) => part.length > 0).join(' · ');
                  })())),
              h('div', { className: 'ove-task-hover' },
                h('button', {
                  type: 'button',
                  className: `ove-hover-btn ${withinInterval(task) ? 'ove-hover-warn' : 'ove-hover-ok'}`,
                  title: tr(task.executionActive === true
                    ? 'auto.deliveringNote'
                    : withinInterval(task) ? 'auto.runIntervalTitle' : 'auto.run'),
                  disabled: busy !== '' || task.executionActive === true,
                  onClick: (event) => {
                    event.stopPropagation();
                    requestRun(task);
                  },
                }, task.executionActive === true
                  ? tr('auto.delivering')
                  : busy === 'run'
                    ? tr('auto.running')
                    : tr(withinInterval(task) ? 'auto.runInterval' : 'auto.run')),
                task.status === 'active' || task.status === 'paused'
                  ? h('button', {
                    type: 'button',
                    className: `ove-hover-btn ${task.status === 'active' ? 'ove-hover-warn' : 'ove-hover-ok'}`,
                    title: tr(task.status === 'active' ? 'auto.pauseTask' : 'auto.resumeTask'),
                    disabled: busy !== '',
                    onClick: (event) => {
                      event.stopPropagation();
                      void toggleActive(task);
                    },
                  }, tr(task.status === 'active' ? 'auto.pauseTask' : 'auto.resumeTask'))
                  : null,
                h('button', {
                  type: 'button',
                  className: 'ove-hover-btn ove-hover-danger',
                  title: tr('auto.deleteTask'),
                  disabled: busy !== '',
                  onClick: (event) => {
                    event.stopPropagation();
                    setConfirm({ ids: [task.id], title: task.title });
                  },
                }, tr('auto.deleteTask')))))),
              ' '))),
          editor,

        portal(intervalRun !== null
          ? h('div', { className: 'ove-overlay ove-overlay-portal' },
            h('div', { className: 'ove-dialog', role: 'dialog', 'aria-modal': 'true' },
              h('h2', { className: 'ove-dialog-title' }, tr('auto.intervalTitle')),
              h('p', { className: 'ove-dialog-desc' }, tr('auto.intervalDesc')),
              h('p', { className: 'ove-dialog-target' }, intervalRun.title),
              h('div', { className: 'ove-dialog-actions' },
                h('button', {
                  type: 'button',
                  className: 'ove-btn',
                  disabled: busy !== '',
                  onClick: () => setIntervalRun(null),
                }, tr('cancel')),
                h('button', {
                  type: 'button',
                  className: 'ove-btn ove-btn-warn',
                  disabled: busy !== '',
                  onClick: () => {
                    const task = intervalRun;
                    setIntervalRun(null);
                    void runNow(task, { confirmed: true });
                  },
                }, busy === 'run' ? tr('auto.running') : tr('auto.intervalConfirm')))))
          : null),

        portal(conflict !== null
          ? h('div', { className: 'ove-overlay ove-overlay-portal' },
            h('div', { className: 'ove-dialog', role: 'dialog', 'aria-modal': 'true' },
              h('h2', { className: 'ove-dialog-title' }, tr('auto.conflictTitle')),
              h('p', { className: 'ove-dialog-desc' }, tr('auto.conflictDesc')),
              conflict.title.length > 0 ? h('p', { className: 'ove-dialog-target' }, conflict.title) : null,
              h('div', { className: 'ove-dialog-actions' },
                h('button', {
                  type: 'button',
                  className: 'ove-btn',
                  disabled: busy !== '',
                  onClick: () => setConflict(null),
                }, tr('cancel')),
                h('button', {
                  type: 'button',
                  className: 'ove-btn ove-btn-warn',
                  disabled: busy !== '',
                  onClick: () => {
                    setConflict(null);
                    void saveDraft({ force: true });
                  },
                }, busy === 'save' ? tr('auto.saving') : tr('auto.conflictOverwrite')))))
          : null),

        portal(confirm !== null
          ? h('div', { className: 'ove-overlay ove-overlay-portal' },
            h('div', { className: 'ove-dialog', role: 'dialog', 'aria-modal': 'true' },
              h('h2', { className: 'ove-dialog-title' }, tr('auto.deleteTitle')),
              h('p', { className: 'ove-dialog-desc' }, tr('auto.deleteDesc')),
              confirm.title.length > 0
                ? h('p', { className: 'ove-dialog-target' }, confirm.title)
                : h('p', { className: 'ove-dialog-target' },
                  selectedRows.map((task) => task.title).join('、')),
              h('div', { className: 'ove-dialog-actions' },
                h('button', {
                  type: 'button',
                  className: 'ove-btn',
                  disabled: busy !== '',
                  onClick: () => setConfirm(null),
                }, tr('cancel')),
                h('button', {
                  type: 'button',
                  className: 'ove-btn ove-btn-danger',
                  disabled: busy !== '',
                  onClick: () => void removeTasks(confirm.ids),
                }, busy === 'delete' ? tr('auto.deleting') : tr('auto.deleteConfirm')))))
          : null),

        portal(bindTasks.length > 0
          ? h('div', { className: 'ove-overlay ove-overlay-portal' },
            h('div', { className: 'ove-dialog', role: 'dialog', 'aria-modal': 'true' },
              h('h2', { className: 'ove-dialog-title' }, tr('auto.bindTitle')),
              h('p', { className: 'ove-dialog-desc' }, tr('auto.bindDesc')),
              h('p', { className: 'ove-dialog-target' }, tr('auto.bindTasks')
                .replace('{names}', bindTasks.map((task) => task.title).join('、'))),
              bindCandidates.length === 0
                ? h('p', { className: 'ove-muted' }, tr('auto.bindEmpty'))
                : h('div', { className: 'ove-session-pick' }, bindCandidates.map((session) => h('label', {
                  className: 'ove-session-option',
                  key: session.id,
                },
                h('input', {
                  type: 'checkbox',
                  className: 'ove-auto-check',
                  checked: bindPicks.has(session.id),
                  onChange: () => setBindPicks((current) => {
                    const next = new Set(current);
                    if (next.has(session.id)) next.delete(session.id);
                    else next.add(session.id);
                    return next;
                  }),
                }),
                h('span', { className: 'ove-session-label' }, sessionNodes(session, tr, bindDuplicates.has(session.id)))))),
              h('div', { className: 'ove-dialog-actions' },
                h('button', {
                  type: 'button',
                  className: 'ove-btn',
                  disabled: busy !== '',
                  onClick: closeBind,
                }, tr('cancel')),
                h('button', {
                  type: 'button',
                  className: 'ove-btn',
                  disabled: busy !== '' || bindPicks.size === 0,
                  onClick: () => void confirmBind(),
                }, busy === 'bind' ? tr('auto.binding') : tr('auto.bindConfirm')))))
          : null));
    }

    /**
     * Sidebar glyph for the enhancement panel.
     * @param props - requested size and selection state from the panel list.
     * @returns the SVG icon.
     */
    function AutomationIcon({ size, active }) {
      const edge = typeof size === 'number' && size > 0 ? size : 18;
      return h('svg', {
        viewBox: '0 0 16 16',
        width: edge,
        height: edge,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { opacity: active ? 1 : 0.85 },
      },
      h('path', { d: 'M2.3 8.6a1.5 1.5 0 0 1 1.5-1.5h8.4a1.5 1.5 0 0 1 1.5 1.5v3.6a1.5 1.5 0 0 1-1.5 1.5H3.8a1.5 1.5 0 0 1-1.5-1.5z' }),
      h('path', { d: 'M8 7.1V4.4M8 4.4 6.3 2.7M8 4.4l1.7-1.7' }),
      h('path', { d: 'M5.2 11.4h1.6M8.6 11.4h2.2' }));
    }

    /* ------------------------------------------------------------------ */
    /* Plugin wiring                                                       */
    /* ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale', 'configForms', 'workspaces', 'sessions', 'uiWorkspace'],
      apply(ctx) {
        // Nothing is registered until the language catalogue and the stylesheet
        // have arrived: mounting first would paint raw key names and unstyled
        // markup, and the fix would only appear on some later re-render. Both are
        // local files read per request, so this settles in one fetch each.
        let disposed = false;
        ctx.effect(() => () => { disposed = true; }, 'original-version-enhancements: assets lifetime');
        const mount = () => { if (!disposed) register(ctx); };
        const report = (what, route) => (error) => {
          // A missing asset must not hide the whole plugin: the interface keeps
          // working (key names, unstyled) and says what it could not load.
          ctx.logger?.warn?.(`original-version-enhancements: could not load the ${what} at ${route}: ${error instanceof Error ? error.message : String(error)}`);
        };
        Promise.all([
          loadCatalogue().then(adoptCatalogue, report('language catalogue', LANG_ROUTE)),
          loadStyle().catch(report('stylesheet', STYLE_ROUTE)),
        ]).then(mount);
      },
    };

    /** Register every slot this plugin contributes, using the loaded catalogues. */
    function register(ctx) {
        const text = (key) => ctx.locale.getSnapshot().active === 'zh' ? (catalogue.zh[key] ?? key) : (catalogue.en[key] ?? key);
        const translator = (key) => text(key);

        ctx.effect(() => ctx.locale.register(NS, catalogue), 'original-version-enhancements: dictionaries');

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
                  id: 'original-version-enhancements.move',
                  order: 480,
                  inject: () => ({ t: translator, ctx, mode: 'move' }),
                }, SessionTransferMenuItem)),
                ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
                  name: 'sidebar.workspaces.session.menu.item',
                  id: 'original-version-enhancements.copy',
                  order: 490,
                  inject: () => ({ t: translator, ctx, mode: 'copy' }),
                }, SessionTransferMenuItem)),
                ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
                  name: 'sidebar.workspaces.session.menu.item',
                  id: 'original-version-enhancements.delete',
                  order: 500,
                  inject: () => ({ t: translator, ctx }),
                }, SessionDeleteMenuItem)),
                ctx.slots.inject('shell.overlay', () => ctx.slots.register({
                  name: 'shell.overlay',
                  id: 'original-version-enhancements.transfer-dialog',
                  inject: () => ({ t: translator, ctx }),
                }, SessionTransferDialog)),
                ctx.slots.inject('shell.overlay', () => ctx.slots.register({
                  name: 'shell.overlay',
                  id: 'original-version-enhancements.transfer-toast',
                  inject: () => ({ t: translator, ctx }),
                }, SessionTransferToast)),
                ctx.slots.inject('shell.overlay', () => ctx.slots.register({
                  name: 'shell.overlay',
                  id: 'original-version-enhancements.delete-dialog',
                  inject: () => ({ t: translator, ctx }),
                }, DeleteDialog)),
                // The deletion receipt lives on the shell so it survives leaving
                // the page it was triggered from.
                ctx.slots.inject('shell.overlay', () => ctx.slots.register({
                  name: 'shell.overlay',
                  id: 'original-version-enhancements.delete-toast',
                  inject: () => ({ t: translator, ctx }),
                }, SessionDeleteToast)),
              ];
            } else if (!enabled && disposers.length > 0) {
              for (const dispose of disposers) dispose();
              disposers = [];
              // Do not resurrect a half-open dialog when the switch is flipped
              // back on: its target may already be gone.
              publishDelete({ target: null, busy: false, error: '', code: '' });
              publishTransfer({ target: null, picks: [], busy: false, error: '', done: '', notice: null });
              // An unclaimed receipt still resolves: the Host keeps its own copy
              // until the sweep, so dropping the notice cannot lose data.
              clearDeleteNotices();
            }
          };
          const unsubscribe = subscribeFlags(sync);
          sync();
          return () => {
            unsubscribe();
            for (const dispose of disposers) dispose();
            disposers = [];
            publishDelete({ target: null, busy: false, error: '', code: '' });
            clearDeleteNotices();
          };
        }, 'original-version-enhancements: chat manager surfaces');

        // The automation panel sits beside the shipped Automation tasks page:
        // it registers its own main key and sidebar cell, so the stock page
        // keeps working and toggling only adds or removes this panel.
        ctx.effect(() => {
          let disposers = [];
          const sync = () => {
            const enabled = getFlags().automation;
            if (enabled && disposers.length === 0) {
              disposers = [
                ctx.slots.inject('main', () => ctx.slots.register({
                  name: 'main',
                  key: AUTOMATION_PANEL,
                  locale: NS,
                  inject: () => ({ t: translator, uiWorkspace: ctx.uiWorkspace }),
                }, AutomationPage)),
                ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
                  name: 'sidebar.panellist',
                  id: AUTOMATION_PANEL,
                  order: 11,
                  locale: NS,
                  label: () => text('auto.panel'),
                }, AutomationIcon)),
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
        }, 'original-version-enhancements: automation panel');

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
    }
  },
});
