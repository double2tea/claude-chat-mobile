// subagent-view.js —— 子代理的会话树与独立会话视窗（纯 Web，不经终端/TUI）。
//
// 数据全部走服务端已登录的 socket 事件，客户端只传 sessionId / agentId / toolUseId，
// 从不拼路径：
//   · subagent:tree   { cwd, sessionId }                    → { ok, subagents: [...] }
//   · subagent:flow   { cwd, sessionId, agentId?/toolUseId? } → { ok, items: [...] }
//   · subagent:fork_chat { cwd, sessionId, agentId }         → { ok, sessionId: 新会话 }
//
// 【为什么单独一个覆盖层而不是复用 #messages】子代理流水与主会话是两条独立的历史源，
// 复用主消息区就得把「当前渲染的是哪一份」塞进整个渲染器；覆盖层只读自己那一份，
// 主会话的滚动、缓存、事件过滤一行都不用改。
import { t } from '../i18n.js';
import { esc, formatToolCardTitle } from '../logic.js';

const FLOW_TIMEOUT_MS = 15000;
const CONTINUE_TIMEOUT_MS = 125000;

// 列表行的副标题：最近工具 · 消息数 · 模型。抽成纯函数以便单测——
// 这些字段各自可选（meta 缺失、流水正在写、老会话没有 model），拼错一个分隔符
// 在手机上就是一条读不通的行。
export function formatSubagentRowMeta(sa, tFn = t) {
  const parts = [];
  if (sa?.lastToolName) parts.push(String(sa.lastToolName));
  if (typeof sa?.messageCount === 'number') parts.push(`${sa.messageCount} ${tFn('条消息')}`);
  if (sa?.model) parts.push(String(sa.model));
  return parts.join(' · ');
}

// 运行状态文案：meta.finished 明确为 false 才算还在跑；缺失（老记录）按已完成显示，
// 免得一条早已结束的子代理永远挂着「运行中」。
export function subagentStateLabel(finished, tFn = t) {
  return finished === false ? tFn('运行中') : tFn('已完成');
}

export function createSubagentView({ socket, getScope, onForkSent, onCountChange } = {}) {
  // 卡片式而不是整屏：背后始终是主会话，收起后落回原位。scrim 只做轻微压暗并承接「点外部收起」。
  const scrim = document.createElement('div');
  scrim.className = 'sa-scrim hidden';
  const root = document.createElement('div');
  root.className = 'sa-view hidden';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'false');
  document.body.append(scrim, root);

  let current = null;
  let treeOpen = false;
  let shown = false;
  let hideTimer = null;
  const drafts = new Map();
  const CLOSE_MS = 220;

  function scope() {
    const s = getScope?.() || {};
    return { cwd: s.cwd || null, sessionId: s.sessionId || null };
  }

  // 收起：先播放下滑/淡出，再真正隐藏。animationend 不可靠（hidden 的父级里不触发），按 transition 时长收尾。
  function close() {
    if (!shown) return;
    shown = false;
    root.classList.add('is-closing');
    scrim.classList.add('is-closing');
    scrim.classList.remove('is-open');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      root.classList.add('hidden');
      root.classList.remove('is-closing');
      root.innerHTML = '';
      scrim.classList.add('hidden');
      scrim.classList.remove('is-closing');
    }, CLOSE_MS);
    current = null;
    treeOpen = false;
  }

  function shell({ title, subtitle, badge, backLabel }) {
    root.innerHTML = '';
    const grab = document.createElement('div');
    grab.className = 'sa-grab';
    grab.setAttribute('aria-hidden', 'true');
    const bar = document.createElement('div');
    bar.className = 'sa-head';
    bar.innerHTML = `
      <button type="button" class="sa-back" data-sa="back">← ${esc(backLabel || t('返回主会话'))}</button>
      <div class="sa-head-main">
        <div class="sa-head-title"></div>
        <div class="sa-head-sub"></div>
      </div>
      <span class="sa-badge"></span>
      <button type="button" class="sa-close" data-sa="close" aria-label="${esc(t('收起'))}">✕</button>`;
    bar.querySelector('.sa-head-title').textContent = title || '';
    bar.querySelector('.sa-head-sub').textContent = subtitle || '';
    const badgeEl = bar.querySelector('.sa-badge');
    if (badge) badgeEl.textContent = badge;
    else badgeEl.remove();
    bar.querySelector('[data-sa="close"]').onclick = () => close();
    bindDrag(grab);
    return { grab, bar };
  }

  // 下拉收起：跟手位移，松手时超过 1/4 卡片高度或甩得够快就收起，否则弹回。
  // 只绑在把手与标题栏上——正文区要能正常上下滚，抢它的手势会让人滚不动历史。
  function bindDrag(handle) {
    let startY = 0;
    let lastY = 0;
    let startAt = 0;
    let dragging = false;
    handle.addEventListener('pointerdown', event => {
      dragging = true;
      startY = lastY = event.clientY;
      startAt = Date.now();
      root.style.transition = 'none';
      scrim.style.transition = 'none';
      handle.setPointerCapture?.(event.pointerId);
    });
    handle.addEventListener('pointermove', event => {
      if (!dragging) return;
      lastY = event.clientY;
      const dy = Math.max(0, lastY - startY);
      root.style.transform = `translateY(${dy}px)`;
      scrim.style.opacity = String(Math.max(0, 1 - dy / (root.offsetHeight || 1)));
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      root.style.transition = '';
      scrim.style.transition = '';
      root.style.transform = '';
      scrim.style.opacity = '';
      const dy = Math.max(0, lastY - startY);
      const fast = dy > 40 && Date.now() - startAt < 300;
      if (dy > (root.offsetHeight || 1) / 4 || fast) close();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  scrim.onclick = () => close();

  function showList(subagents) {
    treeOpen = true;
    const { grab, bar } = shell({
      title: t('子代理会话'),
      subtitle: `${subagents.length} ${t('个子代理')}`,
      backLabel: t('关闭'),
    });
    bar.querySelector('[data-sa="back"]').onclick = () => close();
    const list = document.createElement('div');
    list.className = 'sa-list';
    if (subagents.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sa-empty';
      empty.textContent = t('这个会话还没有子代理');
      list.appendChild(empty);
    }
    for (const sa of subagents) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'sa-row';
      row.innerHTML = `
        <span class="sa-row-main">
          <span class="sa-row-title"></span>
          <span class="sa-row-desc"></span>
          <span class="sa-row-meta"></span>
        </span>
        <span class="sa-row-state"></span>`;
      row.querySelector('.sa-row-title').textContent = sa.agentType || t('子代理会话项');
      row.querySelector('.sa-row-desc').textContent = sa.description || '';
      row.querySelector('.sa-row-meta').textContent = formatSubagentRowMeta(sa);
      row.querySelector('.sa-row-state').textContent = subagentStateLabel(sa.finished);
      row.onclick = () => openAgent(sa);
      list.appendChild(row);
    }
    const body = document.createElement('div');
    body.className = 'sa-flow';
    body.appendChild(list);
    root.append(grab, bar, body);
    show();
  }

  function show() {
    shown = true;
    clearTimeout(hideTimer);
    root.classList.remove('hidden');
    scrim.classList.remove('hidden');
    // 下一帧再上过渡类，否则 display:none → flex 的同一次样式计算里 transition 不生效。
    requestAnimationFrame(() => {
      scrim.classList.add('is-open');
      scrim.classList.remove('is-closing');
      root.classList.remove('is-closing');
    });
  }

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !root.classList.contains('hidden')) close();
  });

  // ---- 单条流水的渲染：与主历史同一份条目形状（role/content 文本、kind=thinking/tool_use/tool_result）----
  function renderItems(container, items) {
    const toolCards = new Map();
    for (const item of items) {
      if (item?.kind === 'tool_result') {
        const card = item.toolUseId ? toolCards.get(item.toolUseId) : null;
        if (card) {
          card.classList.add(item.ok === false ? 'is-error' : 'is-ok');
          const out = card.querySelector('.sa-tool-out');
          if (out && item.outputSummary) {
            out.textContent = String(item.outputSummary);
            out.classList.remove('hidden');
          }
        }
        continue;
      }
      if (item?.kind === 'tool_use') {
        const card = document.createElement('details');
        card.className = 'sa-tool';
        const summary = document.createElement('summary');
        summary.textContent = formatToolCardTitle(item.name || 'tool', item.inputSummary);
        card.appendChild(summary);
        const input = document.createElement('pre');
        input.className = 'sa-tool-in';
        input.textContent = String(item.inputSummary ?? '');
        card.appendChild(input);
        const out = document.createElement('pre');
        out.className = 'sa-tool-out hidden';
        card.appendChild(out);
        if (item.inputSummary && item.inputSummary !== '{}') card.open = false;
        if (item.toolUseId) toolCards.set(item.toolUseId, card);
        container.appendChild(card);
        continue;
      }
      if (item?.kind === 'thinking') {
        const det = document.createElement('details');
        det.className = 'sa-think';
        const sum = document.createElement('summary');
        sum.textContent = t('💭 思考过程');
        const pre = document.createElement('pre');
        pre.textContent = String(item.content ?? '');
        det.append(sum, pre);
        container.appendChild(det);
        continue;
      }
      const text = String(item?.content ?? '');
      if (!text) continue;
      const bubble = document.createElement('div');
      bubble.className = item?.role === 'user' ? 'sa-msg sa-msg-user' : 'sa-msg';
      bubble.textContent = text;
      container.appendChild(bubble);
    }
  }

  function renderAgent(agent) {
    const { grab, bar } = shell({
      title: agent.agentType || t('子代理会话项'),
      subtitle: agent.description || '',
      badge: agent.finished === false ? t('运行中') : t('已完成'),
      backLabel: t('返回'),
    });
    const flow = document.createElement('div');
    flow.className = 'sa-flow';
    const loading = document.createElement('div');
    loading.className = 'sa-empty';
    loading.textContent = t('正在读取子代理执行记录…');
    flow.appendChild(loading);
    const compose = document.createElement('form');
    compose.className = 'sa-composer';
    compose.innerHTML = `
      <textarea rows="2" maxlength="50000" class="sa-input" aria-label="${esc(t('向此子代理提问 / 继续对话…'))}" placeholder="${esc(t('向此子代理提问 / 继续对话…'))}"></textarea>
      <div class="sa-actions">
        <div class="sa-send-status" role="status"></div>
        <div class="sa-split">
          <button type="submit" class="sa-send" value="continue" disabled>${esc(t('继续原子代理'))}</button>
          <details class="sa-send-options">
            <summary aria-label="${esc(t('发送方式'))}" title="${esc(t('发送方式'))}">▾</summary>
            <div class="sa-mode-menu">
              <button type="submit" value="fork" disabled><strong>${esc(t('新开分支并发送'))}</strong><small>${esc(t('继承当前记录，在独立会话中继续'))}</small></button>
            </div>
          </details>
        </div>
      </div>`;
    root.append(grab, bar, flow, compose);
    show();
    return { flow, compose, bar };
  }

  async function openAgent(agent, target = scope()) {
    const { cwd, sessionId } = target;
    if (!sessionId) return;
    const selection = { ...agent, cwd, sessionId };
    current = selection;
    const { flow, compose, bar } = renderAgent(agent);
    const input = compose.querySelector('textarea');
    const primary = compose.querySelector('.sa-send');
    const fork = compose.querySelector('[value="fork"]');
    const options = compose.querySelector('details');
    const status = compose.querySelector('[role="status"]');
    function sync() {
      const draft = selection.draft;
      input.readOnly = Boolean(draft?.busy);
      primary.disabled = !draft || draft.busy || !selection.agentId || !input.value.trim();
      fork.disabled = primary.disabled;
      status.textContent = draft?.notice || '';
      status.classList.toggle('is-error', Boolean(draft?.error));
    }
    function bindDraft() {
      const key = JSON.stringify([cwd, sessionId, selection.agentId || selection.toolUseId]);
      const draft = drafts.get(key) || { text: '', busy: false };
      selection.draftKey = key;
      selection.draft = draft;
      selection.sync = () => { input.value = draft.text; sync(); };
      selection.sync();
    }
    input.disabled = !selection.agentId;
    if (selection.agentId) bindDraft();
    input.oninput = () => {
      const draft = selection.draft;
      if (!draft) return;
      draft.text = input.value;
      draft.notice = '';
      draft.error = false;
      drafts.set(selection.draftKey, draft);
      sync();
    };
    bar.querySelector('[data-sa="back"]').onclick = () => {
      if (treeOpen) return openTree();
      close();
    };
    compose.addEventListener('submit', event => {
      event.preventDefault();
      options.open = false;
      void sendToAgent(selection, event.submitter?.value === 'fork');
    });

    selection.refresh = () => socket.timeout(FLOW_TIMEOUT_MS).emit(
      'subagent:flow',
      { cwd, sessionId, agentId: agent.agentId || undefined, toolUseId: agent.toolUseId || undefined },
      (err, res) => {
        if (current !== selection) return;
        flow.innerHTML = '';
        if (err || !res?.ok) {
          const fail = document.createElement('div');
          fail.className = 'sa-empty';
          fail.textContent = `${t('读取子代理记录失败')}${err ? `: ${err.message}` : res?.reason ? `: ${res.reason}` : ''}`;
          flow.appendChild(fail);
          return;
        }
        current.agentId = res.agentId || current.agentId || null;
        if (!selection.draft) bindDraft();
        input.disabled = false;
        if (res.agentType) {
          bar.querySelector('.sa-head-title').textContent = res.agentType;
          current.agentType = res.agentType;
        }
        if (res.description) {
          bar.querySelector('.sa-head-sub').textContent = res.description;
          current.description = res.description;
        }
        if (!Array.isArray(res.items) || res.items.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'sa-empty';
          empty.textContent = t('没有可显示的子代理执行记录');
          flow.appendChild(empty);
          return;
        }
        renderItems(flow, res.items);
        flow.scrollTop = flow.scrollHeight;
      },
    );
    selection.refresh();
  }

  async function sendToAgent(selection, createFork) {
    const { cwd, sessionId, agentId, toolUseId, draft, draftKey } = selection;
    const text = draft?.text.trim();
    if (!text || draft.busy || !agentId) return;
    draft.busy = true;
    draft.error = false;
    draft.notice = createFork ? t('正在发送…') : t('已请求主会话转达，等待原子代理回复…');
    drafts.set(draftKey, draft);
    selection.sync();
    try {
      if (!socket.connected) throw new Error(t('网络未连接，请等待重新连接后再操作'));
      const outboundKey = createFork ? 'outbound' : 'relay';
      if (draft[outboundKey]?.text !== text) {
        draft[outboundKey] = { text, clientMessageId: `${Date.now()}-${Math.random().toString(36).slice(2)}` };
      }
      if (createFork) {
        if (!draft.branch) {
          const result = await socket.timeout(FLOW_TIMEOUT_MS).emitWithAck('subagent:fork_chat', { cwd, sessionId, agentId, toolUseId });
          if (!result?.ok || !result.instanceId || !result.sessionId || result.sessionId === sessionId) {
            throw new Error(result?.error || result?.reason || t('无法创建分支'));
          }
          draft.branch = result;
        }
        const branchCwd = draft.branch.cwd || cwd;
        if (!draft.branch.instanceId) {
          const restored = await socket.timeout(FLOW_TIMEOUT_MS).emitWithAck('session:switch', { cwd: branchCwd, sessionId: draft.branch.sessionId });
          if (!restored?.ok || restored.sessionId !== draft.branch.sessionId || !restored.instanceId) {
            throw new Error(restored?.error || t('切换失败'));
          }
          draft.branch.instanceId = restored.instanceId;
        }
        const result = await socket.timeout(30000).emitWithAck('user:message', {
          ...draft.outbound, instanceId: draft.branch.instanceId, sessionId: draft.branch.sessionId, cwd: branchCwd,
        });
        if (result?.stale || result?.error === 'stale_instance') {
          draft.branch.instanceId = null;
          throw new Error(t('分支已关闭，再试可继续同一分支'));
        }
        if (!result?.ok) throw new Error(result?.error || t('发送失败'));
        onForkSent?.({ parentSessionId: sessionId, cwd, sessionId: draft.branch.sessionId });
      } else {
        const result = await socket.timeout(CONTINUE_TIMEOUT_MS).emitWithAck('subagent:continue', { cwd, sessionId, agentId, ...draft.relay });
        if (!result?.ok || result.mode !== 'parent_relay' || result.sessionId !== sessionId || result.agentId !== agentId) {
          throw new Error(result?.error || result?.reason || t('尚未确认原子代理回复，请查看记录'));
        }
      }
      drafts.delete(draftKey);
      draft.text = '';
      draft.branch = null;
      draft.outbound = null;
      draft.relay = null;
      draft.notice = '';
      if (current?.draft === draft) {
        if (createFork) close();
        else current.refresh();
      }
    } catch (error) {
      draft.error = true;
      draft.notice = error.message === 'operation has timed out' ? t('发送结果待确认，请先查看记录再重试') : error.message;
    } finally {
      draft.busy = false;
      if (current?.draft === draft) current.sync();
    }
  }

  function openTree() {
    const { cwd, sessionId } = scope();
    if (!sessionId) return;
    socket.timeout(FLOW_TIMEOUT_MS).emit('subagent:tree', { cwd, sessionId }, (err, res) => {
      if (err || !res?.ok) {
        treeOpen = true;
        current = null;
        showList([]);
        return;
      }
      current = null;
      treeOpen = true;
      showList(Array.isArray(res.subagents) ? res.subagents : []);
      onCountChange?.(res.subagents?.length || 0);
    });
  }

  function refreshCount() {
    const { cwd, sessionId } = scope();
    if (!sessionId) return onCountChange?.(0);
    socket.timeout(FLOW_TIMEOUT_MS).emit('subagent:tree', { cwd, sessionId }, (err, res) => {
      if (err || !res?.ok) return onCountChange?.(0);
      onCountChange?.(Array.isArray(res.subagents) ? res.subagents.length : 0);
    });
  }

  // 主聊天流里的子代理卡直接点进来：只有 toolUseId，agentId 由服务端按 meta 反查。
  function openByToolUseId(toolUseId, { agentType = null, description = null } = {}) {
    if (!toolUseId) return;
    void openAgent({ toolUseId, agentType, description });
  }

  // clear：切到没有 sessionId 的表面（首页/新会话页）时收起入口，不发起扫描。
  function clear() {
    onCountChange?.(0);
  }

  return { openTree, openAgent, openByToolUseId, refreshCount, clear, close };
}
