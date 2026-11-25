import { useCallback, useEffect, useRef, useState } from 'react';
import { api, readApiJson } from '@/shared/api';
import type { AntigravityAccount, AntigravityConversation, AntigravityHistory, AntigravityMessage, AntigravityModel, AntigravityQuota } from '@/shared/types';
import { applyAntigravityEvent, readAntigravityEvents } from '@/modules/antigravity/stream';

// Only an opaque task ID survives navigation; prompts and account authorization are never stored here.
const PENDING_TURN_KEY = 'mint.antigravity.pendingTurn';
const pendingTurn = () => { try { return sessionStorage.getItem(PENDING_TURN_KEY); } catch { return null; } };
const rememberTurn = (id: string) => { try { sessionStorage.setItem(PENDING_TURN_KEY, id); } catch { /* Storage can be disabled. */ } };
const forgetTurn = (id: string) => { try { if (pendingTurn() === id) sessionStorage.removeItem(PENDING_TURN_KEY); } catch { /* Storage can be disabled. */ } };

/** Used only by AntigravityWorkspace to share the existing agy account, history and detached-turn service. */
export function useAntigravity() {
  // Each collection comes from the existing agy backend, preserving all saved accounts and conversations.
  const [accounts, setAccounts] = useState<AntigravityAccount[]>([]);
  const [models, setModels] = useState<AntigravityModel[]>([]);
  const [conversations, setConversations] = useState<AntigravityConversation[]>([]);
  // The quota snapshot is cleared on identity changes so another account's allowance is never reused.
  const [quota, setQuota] = useState<AntigravityQuota | null>(null);
  // Only the viewed conversation is loaded; its revision prevents overwriting a newer device's history.
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AntigravityMessage[]>([]);
  // Busy covers the attached native turn, while loading protects a conversation change from a send.
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  // Human-readable failures stay visible instead of converting missing quota or history into empty success.
  const [notice, setNotice] = useState('');
  const [quotaLoading, setQuotaLoading] = useState(false);
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const currentId = useRef<string | null>(null);
  const currentTurn = useRef<string | null>(null);
  const revision = useRef<string | null>(null);
  const identity = useRef('');
  const accountEpoch = useRef(0);
  const activeMessage = useRef<string | null>(null);
  const running = useRef(false);

  const reloadAccounts = useCallback(async () => {
    const value = await readApiJson<{ accounts: AntigravityAccount[] }>(await api.antigravity.accounts());
    if (!mounted.current) return value.accounts;
    const id = value.accounts.find(item => item.active)?.id || '';
    if (identity.current !== id) { identity.current = id; accountEpoch.current += 1; setQuota(null); }
    setAccounts(value.accounts);
    return value.accounts;
  }, []);
  const reloadConversations = useCallback(async () => {
    const value = await readApiJson<{ conversations: AntigravityConversation[]; active_id?: string }>(await api.antigravity.conversations());
    if (mounted.current) setConversations(value.conversations || []);
    return value;
  }, []);
  const refreshQuota = useCallback(async (force = false) => {
    const epoch = accountEpoch.current;
    if (mounted.current) setQuotaLoading(true);
    try {
      const value = await readApiJson<AntigravityQuota>(await api.antigravity.quota(force));
      if (mounted.current && epoch === accountEpoch.current) setQuota(value);
    } catch (error) {
      if (mounted.current && epoch === accountEpoch.current) {
        setQuota(null);
        setNotice(error instanceof Error ? error.message : '额度读取失败，请稍后重试。');
      }
    } finally { if (mounted.current) setQuotaLoading(false); }
  }, []);

  const subscribe = useCallback(async (response: Response, abort: AbortController) => {
    await readAntigravityEvents(response, event => {
      if (abort.signal.aborted || !mounted.current) return;
      if (event.turn_id) currentTurn.current = event.turn_id;
      if (event.conversation_id) {
        currentId.current = event.conversation_id; setConversationId(event.conversation_id);
      }
      if (event.event === 'done') return;
      const targetId = activeMessage.current;
      setMessages(previous => {
        const messageId = targetId;
        const index = previous.findIndex(item => item.id === messageId);
        const message = index < 0 ? { id: messageId || crypto.randomUUID(), role: 'assistant', content: '' } : previous[index];
        const next = applyAntigravityEvent(message, event);
        if (index < 0) return [...previous, next];
        return previous.map((item, position) => position === index ? next : item);
      });
      if (event.event === 'snapshot' && event.message?.id) activeMessage.current = event.message.id;
    });
  }, []);

  const openConversation = useCallback(async (id: string) => {
    if (running.current) return;
    setLoading(true); setNotice('');
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    try {
      const data = await readApiJson<AntigravityHistory>(await api.antigravity.messages(id, abort.signal));
      if (!mounted.current || abort.signal.aborted) return;
      currentId.current = id; setConversationId(id); revision.current = data.revision;
      setMessages(data.messages || []);
      if (data.active_turn) {
        currentTurn.current = data.active_turn.id;
        activeMessage.current = data.messages?.slice().reverse().find(item => item.role === 'assistant')?.id || crypto.randomUUID();
        running.current = true; setBusy(true);
        const response = await api.antigravity.events(data.active_turn.id, abort.signal);
        if (!response.ok) { await readApiJson(response); return; }
        await subscribe(response, abort);
        const final = await readApiJson<AntigravityHistory>(await api.antigravity.messages(id, abort.signal));
        if (!abort.signal.aborted && mounted.current) { setMessages(final.messages || []); revision.current = final.revision; }
      }
    } catch (error) {
      if (!abort.signal.aborted && mounted.current) setNotice(error instanceof Error ? error.message : '聊天读取失败');
    } finally {
      if (controller.current === abort) { running.current = false; if (mounted.current) { setLoading(false); setBusy(false); } }
    }
  }, [subscribe]);

  const resumeTurn = useCallback(async (id: string) => {
    if (running.current) return true;
    const abort = new AbortController(); controller.current?.abort(); controller.current = abort;
    setLoading(true); setNotice('');
    try {
      const response = await api.antigravity.turn(id, abort.signal);
      if (response.status === 404) { forgetTurn(id); return false; }
      const turn = await readApiJson<{ id: string; conversation_id: string | null; status: string; message: AntigravityMessage }>(response);
      if (!mounted.current || abort.signal.aborted) return true;
      if (turn.status !== 'running' && turn.conversation_id) {
        forgetTurn(id); await openConversation(turn.conversation_id); return true;
      }
      currentTurn.current = id; currentId.current = turn.conversation_id; setConversationId(turn.conversation_id);
      activeMessage.current = turn.message.id || crypto.randomUUID();
      if (turn.conversation_id) {
        const history = await readApiJson<AntigravityHistory>(await api.antigravity.messages(turn.conversation_id, abort.signal));
        if (abort.signal.aborted || !mounted.current) return true;
        setMessages(history.messages || []); revision.current = history.revision;
      } else setMessages([turn.message]);
      if (turn.status === 'running') {
        running.current = true; setBusy(true); setLoading(false);
        const events = await api.antigravity.events(id, abort.signal);
        if (!events.ok) await readApiJson(events);
        await subscribe(events, abort);
      }
      forgetTurn(id);
      if (currentId.current && !abort.signal.aborted) {
        const history = await readApiJson<AntigravityHistory>(await api.antigravity.messages(currentId.current, abort.signal));
        if (mounted.current) { setMessages(history.messages || []); revision.current = history.revision; }
      }
      await reloadConversations();
      return true;
    } catch (error) {
      if (!abort.signal.aborted && mounted.current) setNotice(error instanceof Error ? error.message : '任务接续失败，请刷新重试。');
      return true;
    } finally {
      if (controller.current === abort) { running.current = false; currentTurn.current = null; if (mounted.current) { setBusy(false); setLoading(false); } }
    }
  }, [openConversation, reloadConversations, subscribe]);

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      const results = await Promise.allSettled([
        reloadAccounts(), reloadConversations(),
        api.antigravity.models().then(readApiJson<{ models: AntigravityModel[] }>),
      ]);
      if (!mounted.current) return;
      if (results[2].status === 'fulfilled') setModels(results[2].value.models || []);
      for (const result of results) if (result.status === 'rejected') setNotice('部分 agy 数据暂时无法读取，可稍后刷新。');
      const listing = results[1].status === 'fulfilled' ? results[1].value : null;
      const detached = pendingTurn();
      if (detached && await resumeTurn(detached)) { void refreshQuota(); return; }
      if (listing?.active_id) await openConversation(listing.active_id);
      else setLoading(false);
      void refreshQuota();
    })();
    const timer = window.setInterval(() => {
      if (!document.hidden) void reloadAccounts().then(() => refreshQuota()).catch(() => {});
    }, 60000);
    return () => { mounted.current = false; clearInterval(timer); controller.current?.abort(); };
  }, [openConversation, refreshQuota, reloadAccounts, reloadConversations, resumeTurn]);

  const send = async (
    content: string,
    model: string,
    cwd: string,
    attachments: AntigravityMessage['attachments'],
    options?: { useArmor?: boolean; useTransam?: boolean; useAgyFast?: boolean; useClaudeAgy?: boolean },
  ) => {
    if (running.current || !content.trim() && !attachments?.length) return false;
    running.current = true; setBusy(true); setNotice('');
    const abort = new AbortController(); controller.current = abort;
    const message: AntigravityMessage = { id: crypto.randomUUID(), role: 'user', content, attachments };
    const snapshot = [...messages, message];
    activeMessage.current = crypto.randomUUID();
    currentTurn.current = crypto.randomUUID().replace(/-/g, '');
    const submittedTurn = currentTurn.current;
    rememberTurn(submittedTurn);
    setMessages([...snapshot, { id: activeMessage.current, role: 'assistant', content: '', status: 'streaming' }]);
    let accepted = false;
    try {
      const response = await api.antigravity.chat({
        messages: snapshot, message_snapshot: snapshot, model: model || undefined, cwd: cwd || undefined,
        conversation_id: currentId.current, history_revision: revision.current,
        turn_id: currentTurn.current, model_label: models.find(item => item.id === model)?.name || model,
        ...(options?.useArmor ? { use_armor: true } : {}),
        ...(options?.useTransam ? { use_transam: true } : {}),
        ...(options?.useAgyFast ? { use_agy_fast: true } : {}),
        ...(options?.useClaudeAgy ? { use_claude_agy: true } : {}),
      }, abort.signal);
      if (!response.ok) { await readApiJson(response); return false; }
      accepted = true;
      await subscribe(response, abort);
      forgetTurn(submittedTurn);
      if (currentId.current && !abort.signal.aborted) {
        const final = await readApiJson<AntigravityHistory>(await api.antigravity.messages(currentId.current, abort.signal));
        if (mounted.current) { setMessages(final.messages || []); revision.current = final.revision; }
      }
      await reloadConversations(); void refreshQuota();
      return true;
    } catch (error) {
      if (!accepted && !abort.signal.aborted) forgetTurn(submittedTurn);
      if (!accepted && mounted.current) setMessages(messages);
      if (!abort.signal.aborted && mounted.current) setNotice(error instanceof Error ? error.message : '发送失败，请先同步聊天再重试。');
      return false;
    } finally {
      running.current = false; currentTurn.current = null;
      if (mounted.current) setBusy(false);
    }
  };
  const switchAccount = async (id: string) => {
    if (running.current) return;
    setNotice(''); setQuota(null); accountEpoch.current += 1;
    await readApiJson(await api.antigravity.switchAccount(id));
    await reloadAccounts();
    const value = await readApiJson<{ models: AntigravityModel[] }>(await api.antigravity.models());
    if (mounted.current) setModels(value.models || []);
    await refreshQuota(true);
  };
  return {
    accounts, models, conversations, quota, messages, conversationId, busy, loading, notice, quotaLoading,
    setNotice, send, openConversation, reloadAccounts, refreshQuota, switchAccount,
    newConversation: () => {
      if (running.current) return;
      currentId.current = null; revision.current = null; setConversationId(null); setMessages([]); setNotice('');
    },
    sync: () => { const detached = pendingTurn(); return detached ? resumeTurn(detached) : currentId.current ? openConversation(currentId.current) : reloadConversations(); },
    stop: async () => { if (currentTurn.current) await readApiJson(await api.antigravity.stop(currentTurn.current)); },
  };
}
