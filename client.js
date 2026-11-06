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
      'switch.automation': '自动化任务增强',
      'switch.automation.desc': '在侧栏新增「自动化增强」面板：选中多个任务批量删除、把一条规则绑定到多个会话、投递后自动清理。原版「自动化任务」页保持不变。',
      pageHint: '归档会话的搜索、取消归档与永久删除位于「设置 → 已归档会话」。',

      'auto.panel': '自动化增强',
      'auto.title': '自动化任务增强',
      'auto.intro': '原版「自动化任务」页负责创建、编辑与记录；这里补上它没有的批量删除、多会话绑定和投递后自动清理。',
      'auto.refresh': '刷新',
      'auto.selectAll': '全选',
      'auto.selected': '已选 {count} 项',
      'auto.deleteSelected': '删除所选',
      'auto.empty': '暂无自动化任务',
      'auto.emptyHint': '先在原版「自动化任务」页创建任务。',
      'auto.loading': '正在读取任务…',
      'auto.error': '读取任务失败',
      'auto.retry': '重试',
      'auto.autoClean': '投递后自动清理',
      'auto.autoCleanHint': '一次性任务投递完成后自动删除',
      'auto.bind': '绑定到多个会话',
      'auto.status.active': '已开启',
      'auto.status.paused': '已暂停',
      'auto.status.ended': '已结束',
      'auto.status.unknown': '未知',
      'auto.target.session': '会话',
      'auto.target.new': '每次新建会话',
      'auto.target.newOnce': '新建并复用会话',
      'auto.target.ungrouped': '未分组',
      'auto.next': '下次',
      'auto.delivered': '已投递',
      'auto.bindTitle': '绑定到其他会话',
      'auto.bindDesc': '为每个选中的会话各复制一份任务（同标题、同指令、同重复规则）；已绑定过的会话会自动跳过。',
      'auto.bindCurrent': '当前目标会话不可重复选择。',
      'auto.bindEmpty': '没有其他可用会话',
      'auto.bindConfirm': '创建副本',
      'auto.binding': '正在创建…',
      'auto.bindDone': '已创建 {count} 个任务',
      'auto.bindFailed': '部分会话创建失败：{names}',
      'auto.deleteTitle': '删除所选任务？',
      'auto.deleteDesc': '任务会被删除；已投递的消息和目标会话会保留。',
      'auto.deleteConfirm': '确认删除',
      'auto.deleting': '正在删除…',
      'auto.deleted': '已删除 {count} 个任务',
      'auto.deleteFailed': '有 {count} 个任务删除失败',

      'auto.new': '新建',
      'auto.newMenu': '新建菜单',
      'auto.newManual': '手动创建',
      'auto.newMulti': '绑定到多个会话',
      'auto.tab.active': '已开启',
      'auto.tab.paused': '已暂停',
      'auto.tab.ended': '已结束',
      'auto.tab.all': '全部',
      'auto.search': '搜索自动化任务',
      'auto.select': '选择任务',
      'auto.selectAll': '全选',
      'auto.clearSelection': '取消选择',
      'auto.emptyAction': '新建自动化任务',
      'auto.noMatches': '没有匹配的自动化任务',
      'auto.nextAt': '下次计划时间',
      'auto.cleanShort': '自动清理',
      'auto.inMinutes': '{n} 分钟后',
      'auto.inHours': '{n} 小时后',
      'auto.inDays': '{n} 天后',
      'auto.once': '仅一次',
      'auto.after': '{n} 分钟后执行',
      'auto.every': '每 {n} 分钟',
      'auto.daily': '每天',
      'auto.weekly': '每周',
      'auto.custom': '自定义',
      'auto.weekday.sun': '周日',
      'auto.weekday.mon': '周一',
      'auto.weekday.tue': '周二',
      'auto.weekday.wed': '周三',
      'auto.weekday.thu': '周四',
      'auto.weekday.fri': '周五',
      'auto.weekday.sat': '周六',
      'auto.createTitle': '新建自动化任务',
      'auto.editTitle': '编辑自动化任务',
      'auto.name': '自动化任务名称',
      'auto.content': '自动化任务内容',
      'auto.target': '执行位置',
      'auto.session': '关联会话',
      'auto.pickSession': '选择会话',
      'auto.archived': '已归档',
      'auto.workspace': '关联工作区',
      'auto.workspaceDefault': '不指定（跟随默认）',
      'auto.repeat': '重复',
      'auto.repeat.at': '一次',
      'auto.repeat.every': '按分钟',
      'auto.repeat.daily': '每天',
      'auto.repeat.weekly': '每周',
      'auto.repeat.rrule': '自定义',
      'auto.date': '日期',
      'auto.time': '时间',
      'auto.interval': '间隔（分钟）',
      'auto.weekday': '星期',
      'auto.rule': 'RRULE',
      'auto.clean': '投递后自动清理',
      'auto.save': '保存',
      'auto.saving': '正在保存…',
      'auto.saved': '已保存',
      'auto.ran': '已开始投递',
      'auto.run': '立即投递',
      'auto.running': '投递中…',
      'auto.lastDelivery': '上次投递',
      'auto.notDelivered': '尚未投递',
      'auto.cleanOnceOnly': '只有不勾选「重复」的任务会在投递后清理',
      'auto.bindSkipped': '已跳过 {count} 个已绑定的会话',
      'auto.bindTasks': '任务：{names}',
      'auto.repeatToggle': '重复',
      'auto.repeatHint': '不勾选则 {n} 分钟后只运行一次',
      'auto.records': '运行记录',
      'auto.recordsEmpty': '暂无运行记录',
      'auto.recordsClear': '清除全部',
      'auto.recordDelete': '删除这条记录',
      'auto.recordsHidden': '本面板已隐藏 {count} 条',
      'auto.trim': '运行后删除本次运行记录',
      'auto.trimHint': '每次投递后自动隐去这一次的记录',
      'auto.pauseSelected': '暂停所选',
      'auto.pausedMany': '已暂停 {count} 个任务',
      'auto.pauseNone': '所选任务都已暂停',
      'auto.clear': '清除运行记录',
      'auto.clearTitle': '清除运行记录？',
      'auto.clearDesc': '所有任务的运行记录都会从面板中清除，已结束的任务一并删除；已开启或已暂停的任务、原会话与已排队消息不受影响。',
      'auto.clearCount': '将清除 {count} 条运行记录',
      'auto.clearConfirm': '清除',
      'auto.clearing': '正在清除…',
      'auto.cleared': '已清除 {count} 条运行记录',
      'auto.clearEmpty': '没有可清除的运行记录',
      'auto.ruleExample': '示例（点击填入）',
      'auto.ruleEx1': '每周一、三、五 09:00',
      'auto.ruleEx2': '每两天 09:00',
      'auto.ruleEx3': '每月 1 号 09:00',
      'auto.pause': '暂停',
      'auto.resume': '恢复',
      'auto.deleteTask': '删除任务',
      'auto.needName': '请填写任务名称。',
      'auto.needContent': '请填写任务内容。',
      'auto.needTiming': '时间设置无效。',
      'auto.needSession': '请选择一个会话。',

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
      'switch.automation': 'Automation task enhancements',
      'switch.automation.desc': 'Adds an Automation enhancements sidebar panel: delete selected tasks, bind one rule to several conversations, and auto-clean after delivery. The stock Automation tasks page stays as it is.',
      pageHint: 'Archive search, unarchive and permanent deletion live in Settings → Archived sessions.',

      'auto.panel': 'Automation enhancements',
      'auto.title': 'Automation task enhancements',
      'auto.intro': 'The stock Automation tasks page creates, edits and records tasks. This panel adds what it lacks: bulk deletion, multi-conversation binding, and auto-clean after delivery.',
      'auto.refresh': 'Refresh',
      'auto.selectAll': 'Select all',
      'auto.selected': '{count} selected',
      'auto.deleteSelected': 'Delete selected',
      'auto.empty': 'No automation tasks',
      'auto.emptyHint': 'Create one on the stock Automation tasks page first.',
      'auto.loading': 'Loading tasks…',
      'auto.error': 'Could not load tasks',
      'auto.retry': 'Retry',
      'auto.autoClean': 'Auto-clean after delivery',
      'auto.autoCleanHint': 'Delete a one-shot task once its delivery completes',
      'auto.bind': 'Bind to conversations',
      'auto.status.active': 'Enabled',
      'auto.status.paused': 'Paused',
      'auto.status.ended': 'Ended',
      'auto.status.unknown': 'Unknown',
      'auto.target.session': 'Conversation',
      'auto.target.new': 'New conversation each run',
      'auto.target.newOnce': 'New conversation reused',
      'auto.target.ungrouped': 'Ungrouped',
      'auto.next': 'Next',
      'auto.delivered': 'Delivered',
      'auto.bindTitle': 'Bind to other conversations',
      'auto.bindDesc': 'Copies every selected task — same title, instruction and rule — into each conversation; conversations that already have it are skipped.',
      'auto.bindCurrent': 'The current target conversation cannot be selected again.',
      'auto.bindEmpty': 'No other conversation available',
      'auto.bindConfirm': 'Create copies',
      'auto.binding': 'Creating…',
      'auto.bindDone': 'Created {count} tasks',
      'auto.bindFailed': 'Some conversations failed: {names}',
      'auto.deleteTitle': 'Delete the selected tasks?',
      'auto.deleteDesc': 'The tasks are removed; delivered messages and their conversations stay.',
      'auto.deleteConfirm': 'Delete',
      'auto.deleting': 'Deleting…',
      'auto.deleted': 'Deleted {count} tasks',
      'auto.deleteFailed': '{count} tasks could not be deleted',

      'auto.new': 'New',
      'auto.newMenu': 'New task menu',
      'auto.newManual': 'Create manually',
      'auto.newMulti': 'Bind to conversations',
      'auto.tab.active': 'Enabled',
      'auto.tab.paused': 'Paused',
      'auto.tab.ended': 'Ended',
      'auto.tab.all': 'All',
      'auto.search': 'Search automation tasks',
      'auto.select': 'Select task',
      'auto.selectAll': 'Select all',
      'auto.clearSelection': 'Clear selection',
      'auto.emptyAction': 'Create an automation task',
      'auto.noMatches': 'No matching automation tasks',
      'auto.nextAt': 'Next run',
      'auto.cleanShort': 'Auto-clean',
      'auto.inMinutes': 'in {n} min',
      'auto.inHours': 'in {n} h',
      'auto.inDays': 'in {n} d',
      'auto.once': 'Once',
      'auto.after': 'in {n} min',
      'auto.every': 'Every {n} min',
      'auto.daily': 'Daily',
      'auto.weekly': 'Weekly',
      'auto.custom': 'Custom',
      'auto.weekday.sun': 'Sun',
      'auto.weekday.mon': 'Mon',
      'auto.weekday.tue': 'Tue',
      'auto.weekday.wed': 'Wed',
      'auto.weekday.thu': 'Thu',
      'auto.weekday.fri': 'Fri',
      'auto.weekday.sat': 'Sat',
      'auto.createTitle': 'New automation task',
      'auto.editTitle': 'Edit automation task',
      'auto.name': 'Task name',
      'auto.content': 'Task instruction',
      'auto.target': 'Destination',
      'auto.session': 'Conversation',
      'auto.pickSession': 'Choose a conversation',
      'auto.archived': 'archived',
      'auto.workspace': 'Workspace',
      'auto.workspaceDefault': 'Not set (use default)',
      'auto.repeat': 'Repeat',
      'auto.repeat.at': 'Once',
      'auto.repeat.every': 'Every N minutes',
      'auto.repeat.daily': 'Daily',
      'auto.repeat.weekly': 'Weekly',
      'auto.repeat.rrule': 'Custom',
      'auto.date': 'Date',
      'auto.time': 'Time',
      'auto.interval': 'Interval (minutes)',
      'auto.weekday': 'Weekday',
      'auto.rule': 'RRULE',
      'auto.clean': 'Auto-clean after delivery',
      'auto.save': 'Save',
      'auto.saving': 'Saving…',
      'auto.saved': 'Saved',
      'auto.ran': 'Delivery started',
      'auto.run': 'Deliver now',
      'auto.running': 'Delivering…',
      'auto.lastDelivery': 'Last delivery',
      'auto.notDelivered': 'Not delivered yet',
      'auto.cleanOnceOnly': 'Only tasks without Repeat are cleaned after delivery',
      'auto.bindSkipped': 'Skipped {count} conversations that already had the task',
      'auto.bindTasks': 'Tasks: {names}',
      'auto.repeatToggle': 'Repeat',
      'auto.repeatHint': 'Leave unchecked to run once after {n} minutes',
      'auto.records': 'Run records',
      'auto.recordsEmpty': 'No run records yet',
      'auto.recordsClear': 'Clear all',
      'auto.recordDelete': 'Delete this record',
      'auto.recordsHidden': '{count} hidden in this panel',
      'auto.trim': 'Delete this run record after delivery',
      'auto.trimHint': 'Hides the receipt of every delivery it makes',
      'auto.pauseSelected': 'Pause selected',
      'auto.pausedMany': 'Paused {count} tasks',
      'auto.pauseNone': 'Every selected task is already paused',
      'auto.clear': 'Clear run records',
      'auto.clearTitle': 'Clear run records?',
      'auto.clearDesc': 'Every task keeps running, but its run records are cleared from this panel and ended tasks are deleted; conversations and queued messages stay untouched.',
      'auto.clearCount': '{count} run records will be cleared',
      'auto.clearConfirm': 'Clear',
      'auto.clearing': 'Clearing…',
      'auto.cleared': 'Cleared {count} run records',
      'auto.clearEmpty': 'No run records to clear',
      'auto.ruleExample': 'Examples (click to fill)',
      'auto.ruleEx1': 'Every Monday, Wednesday and Friday at 09:00',
      'auto.ruleEx2': 'Every two days at 09:00',
      'auto.ruleEx3': 'The 1st of every month at 09:00',
      'auto.pause': 'Pause',
      'auto.resume': 'Resume',
      'auto.deleteTask': 'Delete task',
      'auto.needName': 'Enter a task name.',
      'auto.needContent': 'Enter the task instruction.',
      'auto.needTiming': 'The schedule is invalid.',
      'auto.needSession': 'Choose a conversation.',

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
      .ove-btn-warn {
        color: #a16207;
        border-color: #eab308;
        background: color-mix(in srgb, #eab308 12%, transparent);
      }
      .ove-btn-warn:hover:not(:disabled) { background: color-mix(in srgb, #eab308 22%, transparent); }
      .ove-repeat-row { display: flex; align-items: center; gap: 8px; }
      .ove-repeat-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
      .ove-example { display: grid; gap: 6px; margin-top: -2px; }
      .ove-example-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
      .ove-example-chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .ove-example-chip {
        border: .5px solid var(--dsw-alias-border-l2); background: transparent; border-radius: 7px;
        font: inherit; font-size: 12px; line-height: 24px; padding: 0 8px; cursor: pointer;
        color: var(--dsw-alias-label-secondary);
      }
      .ove-example-chip:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
      .ove-records-head { display: flex; align-items: center; gap: 8px; }
      .ove-link-btn {
        margin-left: auto; border: 0; background: transparent; font: inherit; font-size: 12px; line-height: 18px;
        color: var(--dsw-alias-brand-primary, #4f7cff); cursor: pointer; padding: 2px 6px; border-radius: 6px;
      }
      .ove-link-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
      .ove-link-btn:disabled { opacity: .5; cursor: default; }
      .ove-records-empty { margin: 0; }
      .ove-record-list {
        list-style: none; margin: 0; padding: 2px; display: grid; gap: 1px; max-height: 176px; overflow: auto;
        border-radius: 10px; background: var(--dsw-alias-bg-layer-1);
      }
      .ove-record {
        display: flex; align-items: center; gap: 8px; padding: 3px 8px; border-radius: 8px;
        font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-secondary);
      }
      .ove-record-time { flex: 1 1 auto; font-variant-numeric: tabular-nums; }
      .ove-record-del {
        border: 0; background: transparent; color: var(--dsw-alias-label-tertiary); font-size: 15px; line-height: 1;
        width: 22px; height: 22px; border-radius: 6px; cursor: pointer;
      }
      .ove-record-del:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-state-error-primary); }
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

      .ove-auto { display: flex; height: 100%; max-height: 100%; min-height: 0; overflow: hidden; background: var(--dsw-alias-bg-base); position: relative; }
      .ove-auto-main { flex: 1 1 auto; min-width: 0; max-height: 100%; display: flex; flex-direction: column; min-height: 0; }
      .ove-auto-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; scrollbar-gutter: stable; }
      .ove-auto-inner { max-width: 900px; margin: 0 auto; padding: 28px clamp(20px, 4vw, 40px) 44px; }
      .ove-auto-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
      .ove-head-actions { display: flex; align-items: center; gap: 8px; }
      .ove-auto-title-text { margin: 0; font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: -.01em; }

      .ove-split { position: relative; display: inline-flex; align-items: stretch; height: 34px; border-radius: 10px; overflow: visible; background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-base); }
      .ove-split-main, .ove-split-more { border: 0; background: transparent; color: inherit; font: inherit; font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; }
      .ove-split-main { padding: 0 14px; gap: 4px; }
      .ove-split-more { padding: 0 8px; border-left: .5px solid rgba(255, 255, 255, .22); }
      .ove-split-main:hover, .ove-split-more:hover { background: rgba(255, 255, 255, .12); }
      .ove-split-menu {
        position: absolute; top: calc(100% + 6px); right: 0; min-width: 190px; z-index: 30;
        padding: 4px; border-radius: 10px; border: .5px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-layer-2); box-shadow: 0 10px 30px rgba(0, 0, 0, .28);
        display: grid; gap: 2px;
      }
      .ove-menu-row {
        border: 0; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px;
        text-align: left; padding: 8px 10px; border-radius: 8px; cursor: pointer;
      }
      .ove-menu-row:hover { background: var(--dsw-alias-bg-layer-1); }
      .ove-menu-row:disabled { opacity: .5; cursor: default; }

      .ove-tabs { display: flex; gap: 2px; margin-bottom: 12px; flex-wrap: wrap; }
      .ove-select-bar { display: flex; align-items: center; padding: 0 12px 6px; }
      .ove-select-all { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-tertiary); cursor: pointer; white-space: nowrap; }
      .ove-tab-count { margin-left: 6px; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
      .ove-tone-active { color: #16a34a; }
      .ove-tone-paused { color: #ca8a04; }
      .ove-tone-ended { color: #dc2626; }
      .ove-tone-all { color: var(--dsw-alias-label-primary, #111827); }
      .ove-tab {
        border: 0; background: transparent; font: inherit; font-size: 13px; line-height: 20px;
        color: var(--dsw-alias-label-tertiary); padding: 6px 12px; border-radius: 8px; cursor: pointer;
      }
      .ove-tab:hover { color: var(--dsw-alias-label-secondary); }
      .ove-tab[aria-selected="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }

      .ove-search-row { position: relative; margin-bottom: 12px; }
      .ove-search-input {
        box-sizing: border-box; width: 100%; height: 38px; padding: 0 12px 0 36px;
        border-radius: 10px; border: .5px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px;
      }
      .ove-search-input:focus { outline: 2px solid var(--dsw-alias-brand-primary, #4f7cff); outline-offset: -1px; }
      .ove-search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--dsw-alias-label-tertiary); display: flex; pointer-events: none; }

      .ove-bulk {
        display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px;
        padding: 8px 12px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1);
        border: .5px solid var(--dsw-alias-border-l1);
      }
      .ove-bulk-count { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-right: auto; }

      .ove-task-list { display: grid; gap: 2px; }
      .ove-task { display: flex; align-items: flex-start; gap: 12px; padding: 10px 12px; border-radius: 10px; cursor: pointer; }
      .ove-task:hover { background: var(--dsw-alias-bg-layer-1); }
      .ove-task[data-active="true"] { background: var(--dsw-alias-bg-layer-2); }
      .ove-task-check { margin-top: 5px; width: 15px; height: 15px; accent-color: var(--dsw-alias-brand-primary, #4f7cff); cursor: pointer; flex: none; }
      .ove-task-icon { color: var(--dsw-alias-label-tertiary); margin-top: 2px; display: flex; flex: none; }
      .ove-task-body { flex: 1 1 auto; min-width: 0; display: grid; gap: 2px; }
      .ove-task-title { font-size: 15px; line-height: 24px; overflow-wrap: anywhere; }
      .ove-task-meta { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
      .ove-task-hover { display: flex; align-items: center; gap: 8px; opacity: 0; transition: opacity .12s; flex: none; }
      .ove-task:hover .ove-task-hover, .ove-task:focus-within .ove-task-hover, .ove-task[data-active="true"] .ove-task-hover { opacity: 1; }
      .ove-clean-toggle { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); cursor: pointer; white-space: nowrap; }
      .ove-hover-btn {
        border: 0; background: transparent; font: inherit; font-size: 12px; line-height: 18px;
        color: var(--dsw-alias-label-secondary); padding: 3px 8px; border-radius: 7px; cursor: pointer; white-space: nowrap;
      }
      .ove-hover-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
      .ove-hover-btn:disabled { opacity: .45; cursor: default; }
      .ove-auto-check { width: 14px; height: 14px; accent-color: var(--dsw-alias-brand-primary, #4f7cff); cursor: pointer; }

      .ove-empty { display: grid; justify-items: center; gap: 14px; padding: 64px 0 48px; text-align: center; }
      .ove-empty-art { color: var(--dsw-alias-label-tertiary); opacity: .45; display: flex; }
      .ove-empty-text { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary); }

      .ove-detail {
        flex: 0 0 380px; width: 380px; max-width: 50%; height: 100%; max-height: calc(100vh - 110px); display: flex; flex-direction: column; min-height: 0; overflow: hidden;
        border-left: .5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base);
      }
      .ove-detail-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 14px 16px 6px; }
      .ove-detail-actions { display: flex; align-items: center; gap: 6px; }
      .ove-detail-actions-row { display: flex; gap: 8px; padding-top: 4px; }
      .ove-primary-sm { height: 28px; padding: 0 12px; font-size: 12px; }
      .ove-detail-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 8px 16px 20px; display: grid; gap: 14px; align-content: start; }
      .ove-detail-foot {
        display: flex; justify-content: flex-end; gap: 8px; padding: 10px 16px;
        border-top: .5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base);
      }
      .ove-field { display: grid; gap: 6px; }
      .ove-label { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
      .ove-input, .ove-select, .ove-textarea {
        box-sizing: border-box; width: 100%; font: inherit; font-size: 13px; line-height: 20px;
        padding: 8px 10px; border-radius: 10px; border: .5px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
      }
      .ove-textarea { min-height: 110px; resize: vertical; }
      .ove-rule { min-height: 96px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
      .ove-inline { display: flex; gap: 8px; }
      .ove-inline > .ove-field { flex: 1 1 0; min-width: 0; }
      .ove-check-row { display: flex; align-items: center; gap: 8px; }
      .ove-icon-btn {
        border: 0; background: transparent; color: var(--dsw-alias-label-tertiary); font-size: 18px; line-height: 1;
        width: 28px; height: 28px; border-radius: 8px; cursor: pointer;
      }
      .ove-icon-btn:hover { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
      .ove-primary {
        border: 0; border-radius: 10px; height: 34px; padding: 0 16px; cursor: pointer;
        background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-base);
        font: inherit; font-size: 13px; display: inline-flex; align-items: center; justify-content: center;
      }
      .ove-primary:disabled { opacity: .5; cursor: default; }
      .ove-session-pick { max-height: 260px; overflow: auto; display: grid; gap: 2px; padding: 4px; border-radius: 10px; background: var(--dsw-alias-bg-base); }
      .ove-session-option { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 8px; font-size: 13px; line-height: 20px; cursor: pointer; }
      .ove-session-option:hover { background: var(--dsw-alias-bg-layer-1); }
      .ove-session-option span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ove-notice { margin: 0 0 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-success-primary, #15803d); }
      .ove-overlay-portal { z-index: 2147483000; }
      @media (max-width: 640px) {
        .ove-detail { position: absolute; inset: 0; width: 100%; z-index: 5; }
      }
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
            error: body?.error?.message || `HTTP ${response.status}`,
            code: typeof body?.error?.code === 'string' ? body.error.code : '',
          };
        }
        return { ok: true, value: body.value };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error), code: '' };
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
     * @returns a relative label, or an empty string when it is in the past.
     */
    const relativeTo = (value, tr) => {
      const time = Date.parse(value ?? '');
      if (Number.isNaN(time)) return '';
      const minutes = Math.round((time - Date.now()) / 60000);
      if (minutes < 1) return '';
      if (minutes < 60) return tr('auto.inMinutes').replace('{n}', String(minutes));
      const hours = Math.round(minutes / 60);
      if (hours < 24) return tr('auto.inHours').replace('{n}', String(hours));
      return tr('auto.inDays').replace('{n}', String(Math.round(hours / 24)));
    };

    const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

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
        case 'every':
          return tr('auto.every').replace('{n}', String(Math.round((task.everySeconds ?? 0) / 60)));
        case 'daily':
          return `${tr('auto.daily')} ${String(task.time ?? '').slice(0, 5)}`.trim();
        case 'weekly':
          return `${tr('auto.weekly')} ${(task.weekdays ?? []).map((day) => tr(`auto.weekday.${WEEKDAY_KEYS[day] ?? 'mon'}`)).join('、')} ${String(task.time ?? '').slice(0, 5)}`.trim();
        case 'cron':
          return tr('auto.custom');
        case 'rrule':
          return tr('auto.custom');
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

    /** Local `HH:mm` of one instant. */
    const clockOf = (when) => `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;

    /**
     * Build the initial editor draft for a new task or an existing row.
     * @param task - the row being edited, or null for a new task.
     * @param cleanFlags - the Host auto-clean map, keyed by task identity.
     * @param trimFlags - the Host "drop this run's record" map.
     * @returns the draft.
     */
    const draftOf = (task, cleanFlags, trimFlags) => {
      const target = task?.target ?? { kind: 'new_once' };
      const existingKind = typeof task?.kind === 'string' ? task.kind : 'every';
      // 按分钟 owns the one-shot case: unchecked Repeat means "run once N minutes
      // from now" (a Host `after` rule), checked means "every N minutes".
      const kind = ['every', 'daily', 'weekly', 'rrule'].includes(existingKind)
        ? existingKind
        : (existingKind === 'cron' ? 'rrule' : 'every');
      const repeat = existingKind === 'every';
      const soon = new Date(Date.now() + 30 * 60 * 1000);
      const delayMinutes = () => {
        if (typeof task?.afterSeconds === 'number' && task.afterSeconds > 0) {
          return String(Math.max(1, Math.round(task.afterSeconds / 60)));
        }
        if (typeof task?.scheduledAt === 'string') {
          const at = Date.parse(task.scheduledAt);
          if (Number.isFinite(at)) return String(Math.max(1, Math.round((at - Date.now()) / 60000)));
        }
        return '30';
      };
      const draft = {
        id: task?.id ?? '',
        title: task?.title ?? '',
        prompt: task?.prompt ?? '',
        repeat,
        kind,
        date: dateOf(soon),
        atTime: clockOf(soon),
        time: typeof task?.time === 'string' ? task.time.slice(0, 5) : clockOf(soon),
        everyMinutes: repeat
          ? (task?.everySeconds ? String(Math.round(task.everySeconds / 60)) : '30')
          : delayMinutes(),
        weekday: Array.isArray(task?.weekdays) && task.weekdays.length > 0 ? task.weekdays[0] : 1,
        rrule: task?.rrule ?? `DTSTART;TZID=${timeZone()}:${dateOf(soon).replace(/-/g, '')}T${clockOf(soon).replace(':', '')}00\nRRULE:FREQ=WEEKLY;BYDAY=MO`,
        targetKind: target.kind === 'session' ? 'session' : target.kind === 'new' ? 'new' : 'new_once',
        sessionId: target.kind === 'session' ? target.sessionId : '',
        cwd: target.cwd ?? '',
        autoClean: task !== null && task !== undefined && cleanFlags !== undefined
          && cleanFlags[task.id] === true,
        trim: task !== null && task !== undefined && trimFlags !== undefined
          && trimFlags[task.id] === true,
        active: task?.status !== 'paused',
      };
      return draft;
    };

    /**
     * Turn an editor draft into a Host timing request.
     * @param draft - editor draft.
     * @returns the timing request, or undefined when the draft is invalid.
     */
    const timingOfDraft = (draft) => {
      const zone = timeZone();
      switch (draft.kind) {
        case 'every': {
          const minutes = Number(draft.everyMinutes);
          if (!Number.isFinite(minutes) || minutes < 1) return undefined;
          // Unchecked Repeat turns the interval into a one-shot delay.
          return draft.repeat === true
            ? { kind: 'every', every_seconds: Math.round(minutes * 60) }
            : { kind: 'after', after_seconds: Math.round(minutes * 60) };
        }
        case 'daily':
          return { kind: 'daily', daily: { time: draft.time, time_zone: zone } };
        case 'weekly':
          return { kind: 'weekly', weekly: { time: draft.time, time_zone: zone, weekdays: [draft.weekday] } };
        case 'rrule':
          return draft.rrule.trim().length > 0 ? { kind: 'rrule', rrule: draft.rrule } : undefined;
        default:
          return undefined;
      }
    };

    const targetOfDraft = (draft) => {
      if (draft.targetKind === 'session') {
        if (typeof draft.sessionId !== 'string' || draft.sessionId.length === 0) return undefined;
        return { kind: 'session', sessionId: draft.sessionId };
      }
      return draft.cwd.length > 0
        ? { kind: draft.targetKind, cwd: draft.cwd }
        : { kind: draft.targetKind };
    };

    /**
     * Automation task management beside the stock Automation tasks page:
     * the same list, tabs and search, plus in-place creation, bulk deletion,
     * multi-conversation binding and the auto-clean flag.
     * @param props - standard panel props and the translator.
     * @returns the automation enhancement page.
     */
    function AutomationPage({ useSessions, useWorkspaces, t }) {
      const tr = typeof t === 'function' ? t : (key) => key;
      const sessions = useSessions((snapshot) => snapshot);
      const workspaces = useWorkspaces((snapshot) => snapshot);

      const [rows, setRows] = React.useState([]);
      const [autoClean, setAutoClean] = React.useState({});
      const [trimFlags, setTrimFlags] = React.useState({});
      const [recordCounts, setRecordCounts] = React.useState({});
      const [loading, setLoading] = React.useState(true);
      const [loadError, setLoadError] = React.useState('');
      const [tab, setTab] = React.useState('active');
      const [query, setQuery] = React.useState('');
      const [selected, setSelected] = React.useState(() => new Set());
      const [busy, setBusy] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [actionError, setActionError] = React.useState('');
      const [draft, setDraft] = React.useState(null);
      const [draftError, setDraftError] = React.useState('');
      const [confirm, setConfirm] = React.useState(null);
      const [bindTasks, setBindTasks] = React.useState([]);
      const [bindPicks, setBindPicks] = React.useState(() => new Set());
      const [cleanPending, setCleanPending] = React.useState(false);
      const [clearConfirm, setClearConfirm] = React.useState(false);
      const [records, setRecords] = React.useState([]);
      const [recordHidden, setRecordHidden] = React.useState(0);
      const [recordsBusy, setRecordsBusy] = React.useState(false);

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
        setTrimFlags(result.value?.trimAfterRun ?? {});
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

      // A saved/deleted/delivered toast is a receipt, not a banner: clear it
      // by itself so it never piles up on top of the next action.
      React.useEffect(() => {
        if (notice.length === 0 && actionError.length === 0) return undefined;
        const timer = setTimeout(() => {
          setNotice('');
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
        setRecords([]);
        setRecordHidden(0);
        setDraftError('');
        setNotice('');
        setActionError('');
      };

      const openEdit = (task) => {
        setDraft(draftOf(task, autoClean, trimFlags));
        setRecords([]);
        setRecordHidden(0);
        setDraftError('');
        setActionError('');
        if (typeof task?.id === 'string' && task.id.length > 0) void loadRecords(task.id);
      };

      const closeDraft = () => {
        setDraft(null);
        setDraftError('');
        setRecords([]);
        setRecordHidden(0);
      };

      const updateDraft = (patch) => setDraft((current) => (current === null ? current : { ...current, ...patch }));

      const saveDraft = async () => {
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
        const clean = draft.kind === 'every' && draft.repeat !== true && draft.autoClean === true;
        const result = draft.id === ''
          ? await automationCall('create', {
            title: draft.title.trim(),
            prompt: draft.prompt,
            timing,
            target,
            autoClean: clean,
          })
          : await automationCall('update', {
            id: draft.id,
            title: draft.title.trim(),
            prompt: draft.prompt,
            timing,
            target,
            active: draft.active,
            autoClean: clean,
          });
        setBusy('');
        if (!result.ok) {
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
          const trim = draft.trim === true;
          const trimmed = await automationCall('trim', { id: savedId, trimAfterRun: trim });
          if (trimmed.ok) {
            setTrimFlags((current) => {
              const next = { ...current };
              if (trim) next[savedId] = true;
              else delete next[savedId];
              return next;
            });
          }
        }
        setNotice(tr('auto.saved'));
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
        await load();
        if (draft !== null && draft.id === task.id) updateDraft({ active: next });
      };

      const runNow = async (task) => {
        if (busy !== '') return;
        setBusy('run');
        setActionError('');
        const result = await automationCall('run', { id: task.id });
        setBusy('');
        if (!result.ok) {
          setActionError(result.error);
          return;
        }
        setNotice(tr('auto.ran'));
        await load();
        if (draft !== null && draft.id === task.id) void loadRecords(task.id);
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
        setNotice(failed === 0
          ? tr('auto.deleted').replace('{count}', String(deleted))
          : tr('auto.deleteFailed').replace('{count}', String(failed)));
        setSelected(new Set());
        if (draft !== null && ids.includes(draft.id)) setDraft(null);
        await load();
      };

      const toggleClean = async (task) => {
        const next = autoClean[task.id] !== true;
        setAutoClean((current) => ({ ...current, [task.id]: next }));
        const result = await automationCall('auto-clean', { id: task.id, autoClean: next });
        if (!result.ok) {
          setAutoClean((current) => {
            const restored = { ...current };
            if (next) delete restored[task.id];
            else restored[task.id] = true;
            return restored;
          });
          setActionError(result.error);
        }
      };

      const pauseSelected = async () => {
        if (busy !== '' || selectedRows.length === 0) return;
        const running = selectedRows.filter((task) => task.status === 'active');
        if (running.length === 0) {
          setActionError(tr('auto.pauseNone'));
          return;
        }
        setBusy('pause');
        setActionError('');
        let failed = 0;
        for (const task of running) {
          const result = await automationCall('update', { id: task.id, active: false });
          if (!result.ok) {
            failed += 1;
            setActionError(result.error);
          }
        }
        setBusy('');
        if (failed === 0) {
          setNotice(tr('auto.pausedMany').replace('{count}', String(running.length)));
          setSelected(new Set());
        }
        await load();
      };

      const clearRecords = async () => {
        if (busy !== '') return;
        setBusy('clear');
        setActionError('');
        const result = await automationCall('clear', {});
        setBusy('');
        setClearConfirm(false);
        if (!result.ok) {
          setActionError(result.error);
          return;
        }
        const deleted = result.value?.deleted ?? 0;
        const records = result.value?.records ?? 0;
        setNotice(records > 0 || deleted > 0
          ? tr('auto.cleared').replace('{count}', String(records))
          : tr('auto.clearEmpty'));
        setSelected(new Set());
        await load();
      };

      const loadRecords = async (id) => {
        if (typeof id !== 'string' || id.length === 0) return;
        const result = await automationCall('history', { id });
        if (!result.ok) return;
        setRecords(Array.isArray(result.value?.records) ? result.value.records : []);
        setRecordHidden(result.value?.hidden ?? 0);
      };

      const applyRecords = (value) => {
        setRecords(Array.isArray(value?.records) ? value.records : []);
        setRecordHidden(value?.hidden ?? 0);
      };

      const deleteRecord = async (record) => {
        if (draft === null || draft.id === '' || recordsBusy) return;
        setRecordsBusy(true);
        const result = await automationCall('hide', { id: draft.id, messageId: record.messageId });
        setRecordsBusy(false);
        if (!result.ok) {
          setActionError(result.error);
          return;
        }
        applyRecords(result.value);
      };

      const clearTaskRecords = async () => {
        if (draft === null || draft.id === '' || recordsBusy) return;
        setRecordsBusy(true);
        const result = await automationCall('hide', { id: draft.id, all: true });
        setRecordsBusy(false);
        if (!result.ok) {
          setActionError(result.error);
          return;
        }
        applyRecords(result.value);
        setRecordCounts((current) => ({ ...current, [draft.id]: { visible: 0, hidden: 0, total: 0 } }));
      };

      const openBind = (tasks) => {
        const list = Array.isArray(tasks) ? tasks.filter((task) => task !== null && task !== undefined) : [];
        setBindTasks(list);
        setBindPicks(new Set());
        setActionError('');
        setNotice('');
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
        const done = tr('auto.bindDone').replace('{count}', String(created));
        const skippedText = skipped > 0 ? `，${tr('auto.bindSkipped').replace('{count}', String(skipped))}` : '';
        if (failed.length === 0) {
          setNotice(`${done}${skippedText}`);
        } else {
          setActionError(tr('auto.bindFailed').replace('{names}', failed
            .map((entry) => (entry.message ? `${sessionTitle(entry.sessionId)}（${entry.message}）` : sessionTitle(entry.sessionId)))
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
        // Every sidebar conversation, tagged with the workspace that owns it. A
        // conversation still carrying its workspace's name is an untitled
        // placeholder; those are what filled the picker with identical rows.
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
            candidates.push({ id, title, stamp: stampOf(id) });
          }
        }
        for (const id of Object.keys(byId)) {
          if (seen.has(id) || archived.has(id)) continue;
          const title = titleOf(id);
          if (title.length === 0) continue;
          candidates.push({ id, title, stamp: stampOf(id) });
        }
        // One row per title: the newest conversation wins, so duplicate names
        // collapse instead of repeating down the list.
        const newest = new Map();
        for (const session of candidates) {
          const current = newest.get(session.title);
          if (current === undefined || session.stamp > current.stamp) newest.set(session.title, session);
        }
        return [...newest.values()]
          .map((session) => ({ ...session, archived: false, label: session.title }))
          .sort((a, b) => a.label.localeCompare(b.label));
      }, [sessions, workspaces]);

      /** Sessions a task may point at, plus its own archived target when it has one. */
      const targetSessions = React.useMemo(() => {
        const current = draft?.sessionId;
        if (typeof current !== 'string' || current.length === 0) return sessionOptions;
        if (sessionOptions.some((session) => session.id === current)) return sessionOptions;
        const record = sessions?.byId?.[current];
        const title = String(record?.displayTitle || current);
        return [{ id: current, title, label: title, archived: true, stamp: 0 }, ...sessionOptions];
      }, [sessionOptions, draft?.sessionId, sessions]);

      /** Conversations that do not already take part in one of the tasks being bound. */
      const bindCandidates = React.useMemo(() => {
        const bound = new Set();
        for (const task of bindTasks) {
          if (task?.target?.kind === 'session') bound.add(task.target.sessionId);
          for (const id of Array.isArray(task?.involvedSessionIds) ? task.involvedSessionIds : []) bound.add(id);
        }
        return sessionOptions.filter((session) => !bound.has(session.id));
      }, [sessionOptions, bindTasks]);

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

      const portal = (node) => (node !== null && node !== undefined
        && typeof ReactDOM?.createPortal === 'function'
        && typeof document !== 'undefined')
        ? ReactDOM.createPortal(node, document.body)
        : node;

      const selectedRows = rows.filter((task) => selected.has(task.id));
      const panelTask = draft !== null && draft.id !== ''
        ? rows.find((task) => task.id === draft.id) ?? null
        : null;
      const oneShot = draft !== null && draft.kind === 'every' && draft.repeat !== true;
      const visibleRecords = Object.values(recordCounts).reduce((total, entry) => total + (entry?.visible ?? 0), 0);

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
              className: 'ove-primary ove-primary-sm',
              disabled: busy !== '',
              onClick: () => void saveDraft(),
            }, busy === 'save' ? tr('auto.saving') : tr('auto.save')),
            h('button', {
              type: 'button',
              className: 'ove-icon-btn',
              'aria-label': tr('cancel'),
              onClick: closeDraft,
            }, '×'))),
        h('div', { className: 'ove-detail-body' },
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
              h('select', {
                className: 'ove-select',
                value: draft.sessionId,
                onChange: (event) => updateDraft({ sessionId: event.target.value }),
              },
              h('option', { value: '' }, tr('auto.pickSession')),
              targetSessions.map((session) => h('option', {
                key: session.id,
                value: session.id,
              }, session.archived ? `${session.label}（${tr('auto.archived')}）` : session.label))))
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
            h('option', { value: 'every' }, tr('auto.repeat.every')),
            h('option', { value: 'daily' }, tr('auto.repeat.daily')),
            h('option', { value: 'weekly' }, tr('auto.repeat.weekly')),
            h('option', { value: 'rrule' }, tr('auto.repeat.rrule')))),
          draft.kind === 'every'
            ? h('div', { className: 'ove-field' },
              h('label', { className: 'ove-repeat-row' },
                h('input', {
                  type: 'checkbox',
                  className: 'ove-auto-check',
                  checked: draft.repeat === true,
                  onChange: () => updateDraft({ repeat: draft.repeat !== true }),
                }),
                h('span', { className: 'ove-label' }, tr('auto.repeatToggle')),
                h('span', { className: 'ove-repeat-hint' },
                  tr('auto.repeatHint').replace('{n}', String(draft.everyMinutes)))),
              h('label', { className: 'ove-field' },
                h('span', { className: 'ove-label' }, tr('auto.interval')),
                h('input', {
                  type: 'number',
                  min: 1,
                  className: 'ove-input',
                  value: draft.everyMinutes,
                  onChange: (event) => updateDraft({ everyMinutes: event.target.value }),
                })))
            : null,
          draft.kind === 'daily'
            ? h('label', { className: 'ove-field' },
              h('span', { className: 'ove-label' }, tr('auto.time')),
              h('input', {
                type: 'time',
                className: 'ove-input',
                value: draft.time,
                onChange: (event) => updateDraft({ time: event.target.value }),
              }))
            : null,
          draft.kind === 'weekly'
            ? h('div', { className: 'ove-inline' },
              h('label', { className: 'ove-field' },
                h('span', { className: 'ove-label' }, tr('auto.weekday')),
                h('select', {
                  className: 'ove-select',
                  value: String(draft.weekday),
                  onChange: (event) => updateDraft({ weekday: Number(event.target.value) }),
                },
                WEEKDAY_KEYS.map((key, index) => h('option', { key, value: String(index) }, tr(`auto.weekday.${key}`))))),
              h('label', { className: 'ove-field' },
                h('span', { className: 'ove-label' }, tr('auto.time')),
                h('input', {
                  type: 'time',
                  className: 'ove-input',
                  value: draft.time,
                  onChange: (event) => updateDraft({ time: event.target.value }),
                })))
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
                      rrule: `DTSTART;TZID=${timeZone()}:${draft.date.replace(/-/g, '')}T${draft.time.replace(':', '')}00\nRRULE:${example.body}`,
                    }),
                  }, tr(example.label))))))
            : null,
          h('div', { className: 'ove-field' },
            h('label', { className: 'ove-check-row' },
              h('input', {
                type: 'checkbox',
                className: 'ove-auto-check',
                checked: oneShot && draft.autoClean,
                disabled: !oneShot,
                onChange: () => updateDraft({ autoClean: !draft.autoClean }),
              }),
              h('span', { className: 'ove-label' }, tr('auto.clean')),
              oneShot ? null : h('span', { className: 'ove-muted' }, tr('auto.cleanOnceOnly'))),
            h('label', { className: 'ove-check-row' },
              h('input', {
                type: 'checkbox',
                className: 'ove-auto-check',
                checked: draft.trim === true,
                onChange: () => updateDraft({ trim: draft.trim !== true }),
              }),
              h('span', { className: 'ove-label' }, tr('auto.trim')),
              h('span', { className: 'ove-muted' }, tr('auto.trimHint')))),
          draft.id !== ''
            ? h('div', { className: 'ove-field ove-records' },
              h('div', { className: 'ove-records-head' },
                h('span', { className: 'ove-label' },
                  `${tr('auto.records')}${records.length > 0 ? `（${records.length}）` : ''}`),
                recordHidden > 0 ? h('span', { className: 'ove-muted' }, tr('auto.recordsHidden').replace('{count}', String(recordHidden))) : null,
                records.length > 0
                  ? h('button', {
                    type: 'button',
                    className: 'ove-link-btn',
                    disabled: recordsBusy,
                    onClick: () => void clearTaskRecords(),
                  }, tr('auto.recordsClear'))
                  : null),
              records.length === 0
                ? h('p', { className: 'ove-muted ove-records-empty' }, tr('auto.recordsEmpty'))
                : h('ul', { className: 'ove-record-list' },
                  records.map((record) => h('li', { key: record.messageId, className: 'ove-record' },
                    h('span', { className: 'ove-record-time' },
                      formatInstant(record.deliveredAt)),
                    h('button', {
                      type: 'button',
                      className: 'ove-record-del',
                      title: tr('auto.recordDelete'),
                      'aria-label': tr('auto.recordDelete'),
                      disabled: recordsBusy,
                      onClick: () => void deleteRecord(record),
                    }, '×')))))
            : null,
          panelTask !== null
            ? h('div', { className: 'ove-detail-actions-row' },
              h('button', {
                type: 'button',
                className: 'ove-btn',
                disabled: busy !== '',
                onClick: () => void runNow(panelTask),
              }, busy === 'run' ? tr('auto.running') : tr('auto.run')),
              h('button', {
                type: 'button',
                className: 'ove-btn',
                disabled: busy !== '',
                onClick: () => void toggleActive(panelTask),
              }, panelTask.status === 'active' ? tr('auto.pause') : tr('auto.resume')),
              h('button', {
                type: 'button',
                className: 'ove-btn ove-btn-danger',
                disabled: busy !== '',
                onClick: () => setConfirm({ ids: [panelTask.id], title: panelTask.title }),
              }, tr('auto.deleteTask')))
            : null,
          draftError.length > 0 ? h('p', { className: 'ove-error' }, draftError) : null));

      return h('div', { className: 'ove-auto' },
        h('style', { key: 'styles', 'data-plugin-css': `${NS}-automation` }, CSS),
        h('div', { className: 'ove-auto-main' },
          h('div', { className: 'ove-auto-scroll' },
            h('div', { className: 'ove-auto-inner' },
              h('div', { className: 'ove-auto-heading' },
                h('h1', { className: 'ove-auto-title-text' }, tr('auto.panel')),
                h('div', { className: 'ove-head-actions' },
                  h('button', {
                    type: 'button',
                    className: 'ove-btn',
                    disabled: busy !== '',
                    title: tr('auto.clearDesc'),
                    onClick: () => setClearConfirm(true),
                  }, tr('auto.clear')),
                  h('button', {
                    type: 'button',
                    className: 'ove-primary',
                    onClick: openNew,
                  }, `+ ${tr('auto.new')}`))),

              h('div', { className: 'ove-tabs', role: 'tablist' },
                tabs.map(([value, label, tone]) => h('button', {
                  key: value,
                  type: 'button',
                  role: 'tab',
                  className: 'ove-tab',
                  'aria-selected': tab === value,
                  onClick: () => setTab(value),
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

              selectedRows.length > 0
                ? h('div', { className: 'ove-bulk' },
                  h('span', { className: 'ove-bulk-count' }, tr('auto.selected').replace('{count}', String(selectedRows.length))),
                  h('button', {
                    type: 'button',
                    className: 'ove-btn',
                    onClick: () => openBind(selectedRows),
                  }, tr('auto.bind')),
                  h('button', {
                    type: 'button',
                    className: 'ove-btn ove-btn-warn',
                    disabled: busy !== '',
                    onClick: () => void pauseSelected(),
                  }, tr('auto.pauseSelected')),
                  h('button', {
                    type: 'button',
                    className: 'ove-btn ove-btn-danger',
                    onClick: () => setConfirm({ ids: selectedRows.map((task) => task.id), title: '' }),
                  }, tr('auto.deleteSelected')),
                  h('button', {
                    type: 'button',
                    className: 'ove-btn',
                    onClick: () => setSelected(new Set()),
                  }, tr('auto.clearSelection')))
                : null,

              notice.length > 0 ? h('p', { className: 'ove-notice' }, notice) : null,
              actionError.length > 0 ? h('p', { className: 'ove-error' }, actionError) : null,

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
                      className: 'ove-auto-check',
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
                    tr('auto.selectAll')))
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
                h('div', { className: 'ove-task-title' }, task.title),
                h('div', { className: 'ove-task-meta' },
                  (() => {
                    const head = task.status === 'active' ? recurrenceOf(task, tr) : statusText(task.status);
                    const relative = task.status === 'active' ? relativeTo(task.scheduledAt, tr) : '';
                    const when = task.scheduledAt
                      ? `${tr('auto.nextAt')}：${formatInstant(task.scheduledAt)}${relative.length > 0 ? `（${relative}）` : ''}`
                      : '';
                    const deliveredAt = task.lastDelivery?.deliveredAt;
                    const delivered = typeof deliveredAt === 'string' && deliveredAt.length > 0
                      ? `${tr('auto.lastDelivery')}：${formatInstant(deliveredAt)}`
                      : '';
                    const runs = recordCounts[task.id]?.visible ?? 0;
                    const runsText = runs > 0 ? `${tr('auto.records')}：${runs}` : '';
                    return [head, when, delivered, runsText].filter((part) => part.length > 0).join(' · ');
                  })())),
              h('div', { className: 'ove-task-hover' },
                h('button', {
                  type: 'button',
                  className: 'ove-hover-btn',
                  title: tr('auto.run'),
                  disabled: busy !== '',
                  onClick: (event) => {
                    event.stopPropagation();
                    void runNow(task);
                  },
                }, busy === 'run' ? tr('auto.running') : tr('auto.run')),
                h('label', {
                  className: 'ove-clean-toggle',
                  title: tr('auto.autoCleanHint'),
                  onClick: (event) => event.stopPropagation(),
                },
                h('input', {
                  type: 'checkbox',
                  className: 'ove-auto-check',
                  checked: autoClean[task.id] === true,
                  onChange: () => void toggleClean(task),
                }),
                tr('auto.cleanShort')))))),
              ' '))),
          editor,

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

        portal(clearConfirm
          ? h('div', { className: 'ove-overlay ove-overlay-portal' },
            h('div', { className: 'ove-dialog', role: 'dialog', 'aria-modal': 'true' },
              h('h2', { className: 'ove-dialog-title' }, tr('auto.clearTitle')),
              h('p', { className: 'ove-dialog-desc' }, tr('auto.clearDesc')),
              h('p', { className: 'ove-dialog-target' }, tr('auto.clearCount')
                .replace('{count}', String(visibleRecords))),
              h('div', { className: 'ove-dialog-actions' },
                h('button', {
                  type: 'button',
                  className: 'ove-btn',
                  disabled: busy !== '',
                  onClick: () => setClearConfirm(false),
                }, tr('cancel')),
                h('button', {
                  type: 'button',
                  className: 'ove-btn ove-btn-danger',
                  disabled: busy !== '',
                  onClick: () => void clearRecords(),
                }, busy === 'clear' ? tr('auto.clearing') : tr('auto.clearConfirm')))))
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
                h('span', null, session.label)))),
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
                  inject: () => ({ t: translator }),
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
      },
    };
  },
});
