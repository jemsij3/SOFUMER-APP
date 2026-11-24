import { useCallback, useEffect, useState } from 'react';
import { Ban, Flag, ImagePlus, MessageSquare, PackageCheck, Send, ShieldOff, Trash2, X } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../lib/api';
import type { Conversation, Message } from '../types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ImageWithFallback } from '../components/ImageWithFallback';

const INQUIRY_TEMPLATES = [
  'Is this item still available?',
  'What are your shipping options & timeline to my country?',
  'Can we confirm the final agreed total and delivery details?',
];

interface BlockedUserItem {
  id: string;
  blocked_user_id: string;
  display_name: string;
  telegram_username?: string;
  reason?: string;
  created_at: string;
}

export function MessagesPage() {
  const {
    user,
    activeConversationId,
    setActiveConversationId,
    requireUserOrPrompt,
    refreshSession,
    navigate,
    notify,
  } = useApp();

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Seller inline "Record Agreed Order" modal state
  const [orderModalOpen, setOrderModalOpen] = useState(false);
  const [agreedTotal, setAgreedTotal] = useState('');
  const [orderCurrency, setOrderCurrency] = useState('USD');
  const [deliveryArrangement, setDeliveryArrangement] = useState('');
  const [paymentArrangement, setPaymentArrangement] = useState('Direct bank/mobile/cash arrangement');
  const [quantity, setQuantity] = useState('1');

  // Blocked Users modal & delete confirmation states
  const [blocksModalOpen, setBlocksModalOpen] = useState(false);
  const [blockedUsers, setBlockedUsers] = useState<BlockedUserItem[]>([]);
  const [blocksLoading, setBlocksLoading] = useState(false);
  const [confirmBlockOpen, setConfirmBlockOpen] = useState(false);
  const [confirmUnblockTarget, setConfirmUnblockTarget] = useState<BlockedUserItem | null>(null);
  const [confirmHideConvTarget, setConfirmHideConvTarget] = useState<Conversation | null>(null);
  const [confirmDeleteMsgTarget, setConfirmDeleteMsgTarget] = useState<Message | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const loadConversations = useCallback(async () => {
    if (!user) return;
    try {
      const res = await apiFetch<{ conversations: Conversation[] }>('/api/conversations');
      setConversations(res.conversations);
      if (!activeConversationId && res.conversations.length > 0) {
        setActiveConversationId(res.conversations[0].id);
      }
    } catch {
      // Handled gracefully
    } finally {
      setLoading(false);
    }
  }, [user, activeConversationId, setActiveConversationId]);

  const loadMessages = useCallback(async (convId: string) => {
    try {
      const res = await apiFetch<{ messages: Message[] }>(`/api/conversations/${convId}/messages`);
      setMessages(res.messages);
      refreshSession();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to load messages', 'error');
    }
  }, [notify, refreshSession]);

  const loadBlockedUsers = useCallback(async () => {
    if (!user) return;
    setBlocksLoading(true);
    try {
      const res = await apiFetch<{ blocks: BlockedUserItem[] }>('/api/users/blocks');
      setBlockedUsers(res.blocks || []);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to load blocked users', 'error');
    } finally {
      setBlocksLoading(false);
    }
  }, [user, notify]);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    loadConversations();
  }, [user, loadConversations]);

  useEffect(() => {
    if (user && activeConversationId) {
      loadMessages(activeConversationId);
    }
  }, [user, activeConversationId, loadMessages]);

  if (!user) {
    return (
      <div className="p-8 rounded-2xl bg-[#0E1525] border border-slate-800 text-center space-y-3">
        <MessageSquare className="w-8 h-8 text-blue-400 mx-auto" />
        <h1 className="text-lg font-semibold text-white">Direct Buyer-Seller Messages</h1>
        <p className="text-sm text-slate-400">Connect with Telegram to view and send private marketplace messages.</p>
        <button
          type="button"
          onClick={() => requireUserOrPrompt()}
          className="h-11 px-5 rounded-xl bg-blue-600 text-white text-sm font-semibold"
        >
          Connect Account
        </button>
      </div>
    );
  }

  const activeConv = conversations.find((c) => c.id === activeConversationId) || null;

  async function sendMessage(bodyText: string, attachmentUrl = '') {
    if (!activeConv) return;
    if (!bodyText.trim() && !attachmentUrl) return;
    setSending(true);
    try {
      await apiFetch(`/api/conversations/${activeConv.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          body: bodyText.trim(),
          attachmentUrl,
          attachmentType: attachmentUrl ? 'image' : '',
        }),
      });
      setText('');
      await loadMessages(activeConv.id);
      await loadConversations();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to send message', 'error');
    } finally {
      setSending(false);
    }
  }

  async function handleImageAttach(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !activeConv) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await apiFetch<{ url: string }>('/api/uploads', {
        method: 'POST',
        body: formData,
      });
      await sendMessage('', res.url);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Image upload failed', 'error');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  async function handleConfirmBlockUser() {
    if (!activeConv || actionBusy) return;
    setActionBusy(true);
    try {
      await apiFetch('/api/users/block', {
        method: 'POST',
        body: JSON.stringify({ userId: activeConv.other_user_id, reason: 'Blocked from chat' }),
      });
      notify(`Blocked ${activeConv.other_user_name}`, 'info');
      setConfirmBlockOpen(false);
      await loadBlockedUsers();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Block failed', 'error');
    } finally {
      setActionBusy(false);
    }
  }

  async function handleConfirmUnblockUser() {
    if (!confirmUnblockTarget || actionBusy) return;
    setActionBusy(true);
    try {
      await apiFetch(`/api/users/block/${confirmUnblockTarget.blocked_user_id}`, { method: 'DELETE' });
      setBlockedUsers((prev) => prev.filter((b) => b.blocked_user_id !== confirmUnblockTarget.blocked_user_id));
      notify(`Unblocked ${confirmUnblockTarget.display_name}`, 'success');
      setConfirmUnblockTarget(null);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unblock failed', 'error');
    } finally {
      setActionBusy(false);
    }
  }

  async function handleConfirmHideConversation() {
    if (!confirmHideConvTarget || actionBusy) return;
    setActionBusy(true);
    try {
      await apiFetch(`/api/conversations/${confirmHideConvTarget.id}`, { method: 'DELETE' });
      const remaining = conversations.filter((c) => c.id !== confirmHideConvTarget.id);
      setConversations(remaining);
      if (activeConversationId === confirmHideConvTarget.id) {
        setActiveConversationId(remaining[0]?.id || null);
        setMessages([]);
      }
      await refreshSession();
      notify('Conversation removed from your inbox', 'info');
      setConfirmHideConvTarget(null);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to hide conversation', 'error');
    } finally {
      setActionBusy(false);
    }
  }

  async function handleConfirmDeleteMessage() {
    if (!confirmDeleteMsgTarget || !activeConv || actionBusy) return;
    setActionBusy(true);
    try {
      await apiFetch(`/api/conversations/${activeConv.id}/messages/${confirmDeleteMsgTarget.id}`, {
        method: 'DELETE',
      });
      setMessages((prev) => prev.filter((m) => m.id !== confirmDeleteMsgTarget.id));
      await loadConversations();
      notify('Message deleted', 'info');
      setConfirmDeleteMsgTarget(null);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to delete message', 'error');
    } finally {
      setActionBusy(false);
    }
  }

  async function handleReportConv() {
    if (!activeConv) return;
    try {
      await apiFetch('/api/marketplace/reports', {
        method: 'POST',
        body: JSON.stringify({
          targetType: 'message',
          targetId: activeConv.id,
          reason: 'Reported buyer-seller conversation',
          details: `Reported participant: ${activeConv.other_user_name}`,
        }),
      });
      notify('Conversation flagged for administrator investigation.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Report failed', 'error');
    }
  }

  async function handleRecordAgreedOrder(e: React.FormEvent) {
    e.preventDefault();
    if (!activeConv || !activeConv.product_id) return;
    try {
      const res = await apiFetch<{ orderId: string; orderNumber: string }>('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          productId: activeConv.product_id,
          buyerUserId: activeConv.other_user_id,
          conversationId: activeConv.id,
          quantity: Number(quantity || 1),
          agreedTotal: Number(agreedTotal || activeConv.product_price || 0),
          currency: orderCurrency,
          paymentArrangement,
          deliveryArrangement,
        }),
      });
      setOrderModalOpen(false);
      notify(`Order ${res.orderNumber} recorded. Buyer notified to confirm.`, 'success');
      await loadMessages(activeConv.id);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to record order', 'error');
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 min-h-[72vh] pb-6">
      {/* Conversation List */}
      <aside className="lg:col-span-4 bg-[#0E1525] border border-slate-800 rounded-2xl overflow-hidden flex flex-col">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between gap-2">
          <div>
            <h1 className="text-base font-semibold text-white">Messages</h1>
            <p className="text-xs text-slate-400">Private direct conversations</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setBlocksModalOpen(true);
              loadBlockedUsers();
            }}
            className="h-8 px-2.5 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-slate-300 hover:text-white inline-flex items-center gap-1"
          >
            <Ban className="w-3.5 h-3.5" />
            <span>Blocked</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-800/70">
          {loading ? (
            <div className="p-4 text-xs text-slate-400">Loading conversations...</div>
          ) : conversations.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-400">
              No conversations yet. Tap Contact Seller on any listing to start negotiating directly.
            </div>
          ) : (
            conversations.map((conv) => (
              <button
                key={conv.id}
                type="button"
                onClick={() => setActiveConversationId(conv.id)}
                className={`w-full p-3.5 text-left transition-colors flex items-start justify-between gap-2 ${
                  activeConv?.id === conv.id ? 'bg-blue-600/15' : 'hover:bg-slate-800/30'
                }`}
              >
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-white truncate">
                    {conv.other_user_name}
                  </div>
                  <div className="text-xs text-blue-400 truncate mt-0.5">{conv.subject}</div>
                  <div className="text-xs text-slate-400 truncate mt-1">
                    {conv.last_message_preview || 'New conversation'}
                  </div>
                </div>
                {conv.unread_count > 0 && (
                  <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-blue-600 text-[11px] font-semibold text-white flex items-center justify-center font-mono-nums shrink-0">
                    {conv.unread_count}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Active Chat Panel */}
      <section className="lg:col-span-8 bg-[#0E1525] border border-slate-800 rounded-2xl flex flex-col overflow-hidden">
        {!activeConv ? (
          <div className="flex-1 flex items-center justify-center p-8 text-sm text-slate-400">
            Select a conversation to view messages.
          </div>
        ) : (
          <>
            {/* Thread Header */}
            <div className="p-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-white truncate">
                  {activeConv.other_user_name}
                  {activeConv.other_telegram_username ? ` (@${activeConv.other_telegram_username})` : ''}
                </div>
                {activeConv.product_id && (
                  <button
                    type="button"
                    onClick={() => navigate({ type: 'product', productId: activeConv.product_id! })}
                    className="text-xs text-blue-400 hover:underline truncate block mt-0.5"
                  >
                    {activeConv.product_title} · {activeConv.product_currency} {activeConv.product_price}
                  </button>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {activeConv.my_role === 'seller' && activeConv.product_id && (
                  <button
                    type="button"
                    onClick={() => {
                      setAgreedTotal(String(activeConv.product_price || ''));
                      setOrderCurrency(activeConv.product_currency || 'USD');
                      setOrderModalOpen((v) => !v);
                    }}
                    className="h-9 px-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <PackageCheck className="w-3.5 h-3.5" />
                    <span>Record Order</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setConfirmBlockOpen(true)}
                  title="Block User"
                  className="h-9 px-2.5 rounded-lg bg-[#070B14] border border-slate-800 text-slate-300 hover:text-white text-xs flex items-center gap-1"
                >
                  <Ban className="w-3.5 h-3.5" />
                  <span>Block</span>
                </button>
                <button
                  type="button"
                  onClick={handleReportConv}
                  title="Report User/Conversation"
                  className="h-9 px-2.5 rounded-lg bg-[#070B14] border border-slate-800 text-slate-300 hover:text-red-300 text-xs flex items-center gap-1"
                >
                  <Flag className="w-3.5 h-3.5" />
                  <span>Report</span>
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmHideConvTarget(activeConv)}
                  title="Remove conversation from your inbox"
                  className="h-9 px-2.5 rounded-lg bg-[#070B14] border border-slate-800 hover:border-red-800/60 text-slate-300 hover:text-red-300 text-xs flex items-center gap-1"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Remove Chat</span>
                </button>
              </div>
            </div>

            {/* Record Agreed Order Form (Seller Only) */}
            {orderModalOpen && (
              <form onSubmit={handleRecordAgreedOrder} className="p-4 bg-[#070B14] border-b border-slate-800 space-y-3">
                <div className="text-xs font-semibold text-white">
                  Record Agreed Direct Order (Buyer will confirm details)
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <input
                    type="number"
                    min="1"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    placeholder="Qty"
                    className="h-10 px-3 rounded-lg bg-[#0E1525] border border-slate-800 text-xs text-white font-mono-nums"
                  />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    value={agreedTotal}
                    onChange={(e) => setAgreedTotal(e.target.value)}
                    placeholder="Agreed Total"
                    className="h-10 px-3 rounded-lg bg-[#0E1525] border border-slate-800 text-xs text-white font-mono-nums"
                  />
                  <input
                    type="text"
                    value={orderCurrency}
                    onChange={(e) => setOrderCurrency(e.target.value.toUpperCase())}
                    placeholder="Currency (USD)"
                    className="h-10 px-3 rounded-lg bg-[#0E1525] border border-slate-800 text-xs text-white"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <input
                    type="text"
                    value={paymentArrangement}
                    onChange={(e) => setPaymentArrangement(e.target.value)}
                    placeholder="Agreed payment method"
                    className="h-10 px-3 rounded-lg bg-[#0E1525] border border-slate-800 text-xs text-white"
                  />
                  <input
                    type="text"
                    required
                    value={deliveryArrangement}
                    onChange={(e) => setDeliveryArrangement(e.target.value)}
                    placeholder="Agreed delivery / shipping terms"
                    className="h-10 px-3 rounded-lg bg-[#0E1525] border border-slate-800 text-xs text-white"
                  />
                </div>
                <div className="flex gap-2">
                  <button type="submit" className="h-9 px-4 rounded-lg bg-blue-600 text-white text-xs font-semibold">
                    Send Order for Buyer Confirmation
                  </button>
                  <button type="button" onClick={() => setOrderModalOpen(false)} className="h-9 px-3 rounded-lg bg-slate-800 text-slate-300 text-xs">
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {/* Messages Timeline */}
            <div className="flex-1 p-4 space-y-3 overflow-y-auto max-h-[52vh]">
              {messages.map((m) => {
                const mine = m.sender_user_id === user.id;
                const canDelete = mine && m.message_type !== 'order_proposal' && m.message_type !== 'system';
                return (
                  <div key={m.id} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
                    <div
                      className={`max-w-[82%] rounded-2xl px-4 py-2.5 text-sm space-y-2 ${
                        m.message_type === 'order_proposal'
                          ? 'bg-purple-950/60 border border-purple-700/50 text-purple-100'
                          : mine
                          ? 'bg-blue-600 text-white'
                          : 'bg-[#131C31] border border-slate-800 text-slate-100'
                      }`}
                    >
                      {m.attachment_url && (
                        <ImageWithFallback
                          src={m.attachment_url}
                          alt="Message attachment"
                          className="rounded-xl max-h-56 object-cover"
                        />
                      )}
                      {m.body && <p className="whitespace-pre-line break-words">{m.body}</p>}
                    </div>
                    <div className="flex items-center gap-2 mt-1 px-1">
                      <span className="text-[10px] text-slate-500">
                        {m.sender_name || (mine ? 'You' : activeConv.other_user_name)} ·{' '}
                        {new Date(m.created_at + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {canDelete && (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteMsgTarget(m)}
                          aria-label="Delete message"
                          title="Delete message"
                          className="text-[10px] text-slate-500 hover:text-red-400 inline-flex items-center gap-0.5"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Inquiry Templates + Composer */}
            <div className="p-3.5 border-t border-slate-800 space-y-2.5 bg-[#0A101D]">
              <div className="flex gap-1.5 overflow-x-auto pb-1">
                {INQUIRY_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl}
                    type="button"
                    onClick={() => setText(tpl)}
                    className="text-[11px] px-2.5 py-1 rounded-lg bg-[#0E1525] border border-slate-800 text-slate-300 hover:border-slate-700 whitespace-nowrap shrink-0"
                  >
                    {tpl}
                  </button>
                ))}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  sendMessage(text);
                }}
                className="flex items-center gap-2"
              >
                <label className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-[#0E1525] border border-slate-800 text-slate-300 hover:text-white cursor-pointer shrink-0">
                  <ImagePlus className="w-4 h-4" />
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    onChange={handleImageAttach}
                    disabled={uploading}
                    className="hidden"
                  />
                </label>
                <input
                  type="text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Write a message..."
                  className="flex-1 h-11 px-3.5 rounded-xl bg-[#0E1525] border border-slate-800 text-sm text-white focus:outline-none focus:border-blue-500"
                />
                <button
                  type="submit"
                  disabled={sending || (!text.trim() && !uploading)}
                  className="h-11 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50 shrink-0"
                >
                  <Send className="w-4 h-4" />
                  <span className="hidden sm:inline">Send</span>
                </button>
              </form>
            </div>
          </>
        )}
      </section>

      {/* Blocked Users Modal */}
      {blocksModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm"
          onClick={() => setBlocksModalOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-[#0E1525] border border-slate-700 p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-white">Blocked Accounts</h2>
              <button
                type="button"
                onClick={() => setBlocksModalOpen(false)}
                className="w-8 h-8 rounded-lg bg-[#070B14] border border-slate-800 text-slate-400 hover:text-white flex items-center justify-center"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {blocksLoading ? (
              <div className="text-xs text-slate-400">Loading blocked users...</div>
            ) : blockedUsers.length === 0 ? (
              <div className="p-4 rounded-xl bg-[#070B14] border border-slate-800 text-xs text-slate-400">
                You have not blocked any marketplace users.
              </div>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {blockedUsers.map((blk) => (
                  <div
                    key={blk.id}
                    className="p-3 rounded-xl bg-[#070B14] border border-slate-800 flex items-center justify-between gap-2 text-xs"
                  >
                    <div>
                      <div className="font-semibold text-white">
                        {blk.display_name}
                        {blk.telegram_username ? ` (@${blk.telegram_username})` : ''}
                      </div>
                      {blk.reason && <div className="text-slate-400">{blk.reason}</div>}
                    </div>
                    <button
                      type="button"
                      onClick={() => setConfirmUnblockTarget(blk)}
                      className="h-8 px-2.5 rounded-lg bg-[#131C31] border border-slate-700 text-blue-300 hover:text-white inline-flex items-center gap-1"
                    >
                      <ShieldOff className="w-3.5 h-3.5" />
                      <span>Unblock</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmBlockOpen}
        title={activeConv ? `Block ${activeConv.other_user_name}?` : 'Block User?'}
        description="They will no longer be able to send you new messages or initiate inquiries."
        consequences={[
          'Messaging will be disabled between your accounts.',
          'You can unblock this user later from the Blocked menu.',
        ]}
        confirmLabel="Block User"
        variant="warning"
        busy={actionBusy}
        onConfirm={handleConfirmBlockUser}
        onCancel={() => setConfirmBlockOpen(false)}
      />

      <ConfirmDialog
        open={Boolean(confirmUnblockTarget)}
        title={confirmUnblockTarget ? `Unblock ${confirmUnblockTarget.display_name}?` : 'Unblock User?'}
        description="They will be allowed to message you again on SOFUMER."
        confirmLabel="Unblock"
        variant="primary"
        busy={actionBusy}
        onConfirm={handleConfirmUnblockUser}
        onCancel={() => setConfirmUnblockTarget(null)}
      />

      <ConfirmDialog
        open={Boolean(confirmHideConvTarget)}
        title="Remove Conversation from Inbox?"
        description={
          confirmHideConvTarget
            ? `Remove "${confirmHideConvTarget.subject}" with ${confirmHideConvTarget.other_user_name} from your message list?`
            : undefined
        }
        consequences={[
          'This hides the thread from your inbox only.',
          'Any recorded direct orders remain intact in My Orders.',
          'Sending or receiving a new message on this listing will reopen the thread.',
        ]}
        confirmLabel="Remove Chat"
        variant="danger"
        busy={actionBusy}
        onConfirm={handleConfirmHideConversation}
        onCancel={() => setConfirmHideConvTarget(null)}
      />

      <ConfirmDialog
        open={Boolean(confirmDeleteMsgTarget)}
        title="Delete This Message?"
        description="Remove this message from the conversation timeline?"
        consequences={[
          'The message text and attachment will be removed for both participants.',
          'Order proposals and system notifications cannot be deleted.',
        ]}
        confirmLabel="Delete Message"
        variant="danger"
        busy={actionBusy}
        onConfirm={handleConfirmDeleteMessage}
        onCancel={() => setConfirmDeleteMsgTarget(null)}
      />
    </div>
  );
}

